import axios from "axios"
import { gotScraping } from "got-scraping"
import { parseImdbCsvText } from "./imdb-csv.js"
import type { WatchlistSource, WatchlistItem } from "./index.js"

// IMDb export system (as of 2026) is fully async and GraphQL-driven.
//
// Flow:
//   1. Warm up session cookies by visiting the IMDb homepage, the user's
//      watchlist page (to discover the list ID), and the /exports/ hub.
//   2. Trigger exports via GraphQL mutations:
//        - createListExport($listId)   — for the watchlist (requires list ID)
//        - createRatingsExport         — for user ratings
//   3. Poll `getExports` until each triggered export reaches status "READY".
//      READY exports include a pre-signed S3 URL for the CSV download.
//   4. Download the CSVs and parse with the existing parseImdbCsvText helper.
//
// The `at-main` session cookie (Amazon auth token) is the primary authenticator,
// but `session-id`, `session-token`, and `ubid-main` must also be present.
// These are obtained by doing a normal page request before hitting the GraphQL API.

const GQL_URL = "https://api.graphql.imdb.com/"

/** Captures an IMDb list ID (ls-number) from a string. */
const LIST_ID_RE = /ls\d{7,10}/

// GraphQL mutation to start a list (watchlist / custom list) export
const START_LIST_EXPORT = `
  mutation StartListExport($listId: ID!) {
    createListExport(input: { listId: $listId }) {
      status { id }
    }
  }
`

// GraphQL mutation to start a ratings export
const START_RATINGS_EXPORT = `
  mutation StartRatingsExport {
    createRatingsExport {
      status { id }
    }
  }
`

// GraphQL query to list pending/ready exports (sorted newest first)
const GET_EXPORTS = `
  query GetExports($first: Int!) {
    getExports(
      first: $first
      input: { exportTypes: [LIST, RATINGS] }
      sort: { by: STARTED_ON, order: DESC }
    ) {
      edges {
        node {
          status { id }
          resultUrl
        }
      }
    }
  }
`

export interface ImdbAutoStatus {
  userId: string
  lists: string[]
  lastFetchAt: string | null
  lastFetchStatus: "ok" | "error" | "never"
  lastFetchCount: number
  lastError: string | null
}

export class ImdbAutoSource implements WatchlistSource {
  private status: ImdbAutoStatus
  // Accumulated session cookies from IMDb page warm-up
  private sessionCookies: Map<string, string> = new Map()

  constructor(
    private readonly userId: string,
    private readonly cookie: string,
    private readonly lists: Array<"watchlist" | "ratings">,
    private readonly minRating: number,
    private readonly pollTimeoutMs: number = 120_000,
    private readonly pollIntervalMs: number = 4_000,
  ) {
    this.status = {
      userId,
      lists: [...lists],
      lastFetchAt: null,
      lastFetchStatus: "never",
      lastFetchCount: 0,
      lastError: null,
    }
    // Seed with the configured at-main cookie
    this.sessionCookies.set("at-main", cookie)
  }

  getStatus(): Readonly<ImdbAutoStatus> {
    return { ...this.status }
  }

  async refresh(): Promise<void> {
    await this.fetchWatchlist()
  }

  async fetchWatchlist(): Promise<WatchlistItem[]> {
    try {
      const items = await this.doFetch()
      this.status = {
        ...this.status,
        lastFetchAt: new Date().toISOString(),
        lastFetchStatus: "ok",
        lastFetchCount: items.length,
        lastError: null,
      }
      return items
    } catch (err) {
      this.status = {
        ...this.status,
        lastFetchAt: new Date().toISOString(),
        lastFetchStatus: "error",
        lastError: (err as Error).message,
      }
      throw err
    }
  }

  private cookieHeader(): string {
    return [...this.sessionCookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
  }

  private collectSetCookies(headers: Record<string, string | string[]>): void {
    const raw = headers["set-cookie"]
    const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
    for (const c of cookies) {
      const pair = c.split(";")[0].trim()
      const idx = pair.indexOf("=")
      if (idx > 0) this.sessionCookies.set(pair.slice(0, idx), pair.slice(idx + 1))
    }
  }

  /** Visit an IMDb page to establish a full session cookie set. */
  private async warmPage(url: string): Promise<string> {
    const res = await gotScraping.get(url, {
      headerGeneratorOptions: {
        browsers: [{ name: "chrome" as const, minVersion: 120 }],
        operatingSystems: ["windows" as const],
      },
      headers: {
        Cookie: this.cookieHeader(),
      },
      followRedirect: true,
      timeout: { request: 15_000 },
      throwHttpErrors: false,
    })
    this.collectSetCookies(res.headers as Record<string, string | string[]>)
    return res.body
  }

  /** Discover the user's watchlist list ID (e.g. "ls056610540") from the page. */
  private async discoverWatchlistId(): Promise<string> {
    // Use gotScraping directly so we can inspect res.url — IMDb often issues a
    // server-side redirect from /user/{id}/watchlist/ to /list/{lsXXX}/ and
    // the list ID is embedded in that final URL.
    const res = await gotScraping.get(
      `https://www.imdb.com/user/${this.userId}/watchlist/`,
      {
        headerGeneratorOptions: {
          browsers: [{ name: "chrome" as const, minVersion: 120 }],
          operatingSystems: ["windows" as const],
        },
        headers: { Cookie: this.cookieHeader() },
        followRedirect: true,
        timeout: { request: 15_000 },
        throwHttpErrors: false,
      },
    )
    this.collectSetCookies(res.headers as Record<string, string | string[]>)
    const html = res.body

    console.log(`  [imdb-auto] watchlist page: HTTP ${res.statusCode}, final URL: ${res.url}, body snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`)

    // Strategy 0: list ID present in the final redirect URL
    const finalUrlMatch = LIST_ID_RE.exec(res.url)
    if (finalUrlMatch) return finalUrlMatch[0]

    const lsCapture = LIST_ID_RE.source // ls\d{7,10}

    // Strategy 1: search inside __NEXT_DATA__ JSON (older IMDb pages)
    const ndm = html.match(
      /<script[^>]+id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>|<script[^>]+type="application\/json"[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    )
    if (ndm) {
      const str = ndm[1] ?? ndm[2]
      const hit =
        str.match(/"listId"\s*:\s*"(ls\d+)"/) ??
        str.match(new RegExp(`"(${lsCapture})"`))
      if (hit) return hit[1]
    }

    // Strategy 2: canonical <link> tag — IMDb often redirects to /list/ls######/
    const canonicalMatch =
      html.match(new RegExp(`<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*/(${lsCapture})[/"'][^>]*>`)) ??
      html.match(new RegExp(`<link[^>]+href=["'][^"']*/(${lsCapture})[/"'][^>]*rel=["']canonical["'][^>]*>`))
    if (canonicalMatch) return canonicalMatch[1]

    // Strategy 3: any <meta> tag whose content looks like a list ID
    const metaMatch = html.match(new RegExp(`<meta[^>]+content=["'](${lsCapture})["'][^>]*>`))
    if (metaMatch) return metaMatch[1]

    // Strategy 4: list ID in any URL path within the page (href/src/data-url attributes)
    const urlPathMatch = html.match(new RegExp(`/list/(${lsCapture})/`))
    if (urlPathMatch) return urlPathMatch[1]

    // Strategy 5: bare ls-number anywhere in the page (last resort)
    const bareMatch = html.match(new RegExp(`"(${lsCapture})"`))
    if (bareMatch) return bareMatch[1]

    throw new Error(
      `Could not find watchlist list ID for user ${this.userId}. ` +
        `Make sure the at-main cookie belongs to this user and the watchlist is not empty.`,
    )
  }

  /** Call the IMDb GraphQL API. */
  private async gql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await axios.post<{ data?: T; errors?: Array<{ message: string }> }>(
      GQL_URL,
      { query, variables },
      {
        headers: {
          Cookie: this.cookieHeader(),
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://www.imdb.com",
          Referer: "https://www.imdb.com/exports/",
        },
        timeout: 20_000,
        validateStatus: () => true,
      },
    )
    this.collectSetCookies(res.headers as Record<string, string | string[]>)
    if (res.data.errors?.length) {
      throw new Error(`IMDb GraphQL: ${res.data.errors[0].message}`)
    }
    if (!res.data.data) {
      throw new Error(`IMDb GraphQL: empty response (HTTP ${res.status})`)
    }
    return res.data.data
  }

  private async doFetch(): Promise<WatchlistItem[]> {
    // Warm up the session (IMDb GraphQL requires more than just at-main)
    console.log(`  [imdb-auto] Warming session for ${this.userId}...`)
    await this.warmPage("https://www.imdb.com/")
    await this.warmPage("https://www.imdb.com/exports/")

    const wantWatchlist = this.lists.includes("watchlist")
    const wantRatings = this.lists.includes("ratings")

    let watchlistListId: string | null = null
    if (wantWatchlist) {
      watchlistListId = await this.discoverWatchlistId()
      console.log(`  [imdb-auto] Watchlist list ID: ${watchlistListId}`)
    }

    // Trigger exports
    const triggerTime = Date.now()

    if (wantWatchlist && watchlistListId) {
      console.log(`  [imdb-auto] Triggering watchlist export...`)
      await this.gql(START_LIST_EXPORT, { listId: watchlistListId })
    }
    if (wantRatings) {
      console.log(`  [imdb-auto] Triggering ratings export...`)
      await this.gql(START_RATINGS_EXPORT)
    }

    // Poll for READY exports
    interface ExportNode {
      status: { id: string }
      resultUrl: string | null
    }
    interface GetExportsResult {
      getExports: { edges: Array<{ node: ExportNode }> }
    }

    const deadline = triggerTime + this.pollTimeoutMs
    let watchlistUrl: string | null = null
    let ratingsUrl: string | null = null

    console.log(`  [imdb-auto] Polling for ready exports (up to ${this.pollTimeoutMs / 1000}s)...`)

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs))

      const data = await this.gql<GetExportsResult>(GET_EXPORTS, { first: 20 })
      const exports_ = data.getExports?.edges?.map((e) => e.node) ?? []

      for (const exp of exports_) {
        if (exp.status.id !== "READY" || !exp.resultUrl) continue
        const url = exp.resultUrl
        // Distinguish by S3 key path segment (/LIST/ vs /RATINGS/)
        if (!ratingsUrl && wantRatings && url.includes("/RATINGS/")) {
          ratingsUrl = url
        }
        if (!watchlistUrl && wantWatchlist && url.includes("/LIST/")) {
          watchlistUrl = url
        }
      }

      const done =
        (!wantWatchlist || watchlistUrl !== null) &&
        (!wantRatings || ratingsUrl !== null)

      if (done) break

      const waiting = [
        wantWatchlist && !watchlistUrl ? "watchlist" : null,
        wantRatings && !ratingsUrl ? "ratings" : null,
      ]
        .filter(Boolean)
        .join(", ")
      console.log(`  [imdb-auto] Still waiting for: ${waiting}`)
    }

    if (wantWatchlist && !watchlistUrl) {
      throw new Error(
        `IMDb watchlist export timed out after ${this.pollTimeoutMs / 1000}s. ` +
          `This may happen if IMDb is slow — try again.`,
      )
    }
    if (wantRatings && !ratingsUrl) {
      throw new Error(
        `IMDb ratings export timed out after ${this.pollTimeoutMs / 1000}s. ` +
          `This may happen if IMDb is slow — try again.`,
      )
    }

    // Download the CSVs
    const all: WatchlistItem[] = []
    const seen = new Set<string>()

    for (const [name, url] of [
      ["watchlist", watchlistUrl],
      ["ratings", ratingsUrl],
    ] as const) {
      if (!url) continue
      console.log(`  [imdb-auto] Downloading ${name} CSV...`)
      const res = await axios.get<string>(url, {
        responseType: "text",
        timeout: 30_000,
        // S3 pre-signed URLs are time-limited; no auth headers needed
        validateStatus: (s: number) => s < 500,
      })
      if (res.status !== 200) {
        throw new Error(
          `IMDb ${name} CSV download failed (HTTP ${res.status}). ` +
            `The pre-signed URL may have expired — try re-fetching.`,
        )
      }
      const items = parseImdbCsvText(res.data, this.minRating).map((item) => ({
        ...item,
        listLabel: name === "watchlist" ? "IMDb Watchlist" : "IMDb Ratings",
      }))
      console.log(`  [imdb-auto] ${name}: ${items.length} items`)
      for (const item of items) {
        if (!seen.has(item.imdbId)) {
          seen.add(item.imdbId)
          all.push(item)
        }
      }
    }

    return all
  }
}

