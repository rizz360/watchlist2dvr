import axios from "axios"
import type { WatchlistSource, WatchlistItem } from "./index.js"

// Fetches one or more public IMDb pages (charts, user lists) and extracts
// the embedded title entries — no authentication required.
//
// Supported URL patterns:
//   https://www.imdb.com/chart/top/           IMDb Top 250
//   https://www.imdb.com/chart/popular/       Most popular
//   https://www.imdb.com/chart/moviemeter/    MovieMeter
//   https://www.imdb.com/list/ls000024621/    Any public user list
//
// Implementation: fetch the HTML page, then try two strategies in order:
//   1. Parse the __NEXT_DATA__ JSON blob embedded by Next.js (older pages)
//      and recursively walk the object tree to find all title entries.
//   2. Parse JSON-LD (<script type="application/ld+json">) blocks which IMDb
//      uses on chart pages (ItemList schema) after migrating away from Next.js.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

/** Regex that captures the tt-identifier from an IMDb title URL path segment. */
const IMDB_TITLE_ID_RE = /\/title\/(tt\d{7,10})\//

const MIN_VALID_YEAR = 1800
const MAX_VALID_YEAR = 2200

/** Number of leading HTML characters to inspect for Cloudflare challenge markers. */
const CF_SAMPLE_SIZE = 2000

export class ImdbPublicListsSource implements WatchlistSource {
  constructor(private readonly urls: string[]) {}

  async fetchWatchlist(): Promise<WatchlistItem[]> {
    const all: WatchlistItem[] = []
    const seen = new Set<string>()

    for (const url of this.urls) {
      const items = await this.fetchList(url)
      console.log(`  [imdb-public] ${url}: ${items.length} items`)
      for (const item of items) {
        if (!seen.has(item.imdbId)) {
          seen.add(item.imdbId)
          all.push(item)
        }
      }
    }

    return all
  }

  private async fetchList(url: string): Promise<WatchlistItem[]> {
    let html: string
    let httpStatus = 0
    try {
      const res = await axios.get<string>(url, {
        responseType: "text",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 20_000,
        // Accept all HTTP status codes so we can give specific error messages
        // for Cloudflare blocks (403/429) vs genuine network failures.
        validateStatus: () => true,
      })
      httpStatus = res.status
      html = res.data
    } catch (err) {
      throw new Error(`Failed to fetch ${url}: ${(err as Error).message}`)
    }

    if (httpStatus === 403 || httpStatus === 429) {
      throw new Error(
        `IMDb rejected the request with HTTP ${httpStatus} for ${url}. ` +
          `This is likely Cloudflare bot detection. ` +
          `A plain HTTP request is no longer sufficient to access IMDb pages.`,
      )
    }

    if (httpStatus !== 200) {
      throw new Error(`Failed to fetch ${url}: HTTP ${httpStatus}`)
    }

    if (isCloudflareChallengeHtml(html)) {
      throw new Error(
        `IMDb returned a Cloudflare challenge page for ${url}. ` +
          `A plain HTTP request is no longer sufficient to access IMDb pages. ` +
          `Consider using a headless browser with stealth mode.`,
      )
    }

    const found = new Map<string, { title: string; year?: number }>()

    // Strategy 1: __NEXT_DATA__ (Next.js embedded JSON, used on older IMDb pages)
    const ndMatch = html.match(
      /<script[^>]+id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>|<script[^>]+type="application\/json"[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    )
    if (ndMatch) {
      const rawJson = ndMatch[1] ?? ndMatch[2]
      try {
        const data = JSON.parse(rawJson)
        walkForTitles(data, found)
      } catch {
        // ignore parse errors and fall through to the next strategy
      }
    }

    // Strategy 2: JSON-LD (application/ld+json) — used by IMDb chart pages
    // after their migration away from Next.js
    if (found.size === 0) {
      const ldJsonRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
      let ldMatch: RegExpExecArray | null
      while ((ldMatch = ldJsonRegex.exec(html)) !== null) {
        try {
          const ldData: unknown = JSON.parse(ldMatch[1])
          walkForTitlesFromLdJson(ldData, found)
        } catch {
          // skip unparseable blocks
        }
      }
    }

    if (found.size === 0) {
      throw new Error(
        `No movie entries found on ${url}. ` +
          `The URL may not be a list/chart page, IMDb's page structure may have changed, ` +
          `or the page content may have been blocked (e.g. Cloudflare bot protection).`,
      )
    }

    const now = new Date()
    return [...found.entries()].map(([imdbId, { title, year }]) => ({
      imdbId,
      originalTitle: title,
      localizedTitles: {},
      year,
      addedAt: now,
      source: "list" as const,
      listLabel: labelFromUrl(url),
    }))
  }
}

/**
 * Returns true if the HTML looks like a Cloudflare challenge or block page
 * rather than real IMDb content.
 *
 * IMDb is protected by Cloudflare, which returns a browser verification
 * challenge (HTTP 200 with a JS-driven challenge page) or a hard block
 * (HTTP 403) when it detects bot-like requests.
 *
 * @internal exported for testing
 */
export function isCloudflareChallengeHtml(html: string): boolean {
  const head = html.slice(0, CF_SAMPLE_SIZE).toLowerCase()
  return (
    head.includes("just a moment") ||
    head.includes("cf-browser-verification") ||
    head.includes("cf-challenge-running") ||
    head.includes("cf_chl_opt") ||
    (head.includes("cloudflare") && head.includes("ray id"))
  )
}

/** Derive a short human-readable label from a public IMDb URL. */
function labelFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "")
    const segment = path.split("/").pop() ?? ""
    const NAMED: Record<string, string> = {
      top: "IMDb Top 250",
      popular: "IMDb Popular",
      moviemeter: "IMDb MovieMeter",
      boxoffice: "IMDb Box Office",
      tvmeter: "IMDb TV Meter",
      toptv: "IMDb Top 250 TV",
      top250: "IMDb Top 250",
    }
    if (NAMED[segment]) return NAMED[segment]
    // User list IDs like ls000024621
    if (/^ls\d+/.test(segment)) return `IMDb List (${segment})`
    return segment || "IMDb List"
  } catch {
    return "IMDb List"
  }
}

/**
 * Recursively walk a parsed JSON object and collect all title entries.
 *
 * A title entry is an object whose "id" property matches "tt\d+" and that
 * also contains a title text in one of the known field shapes IMDb uses:
 *   { titleText: { text: "..." } }
 *   { originalTitleText: { text: "..." } }
 *   { title: "..." }
 *   { originalTitle: "..." }
 */
function walkForTitles(
  node: unknown,
  found: Map<string, { title: string; year?: number }>,
): void {
  if (!node || typeof node !== "object") return

  if (Array.isArray(node)) {
    for (const item of node) walkForTitles(item, found)
    return
  }

  const obj = node as Record<string, unknown>

  const rawId = obj["id"]
  if (typeof rawId === "string" && /^tt\d{7,10}$/.test(rawId) && !found.has(rawId)) {
    const title =
      extractText(obj["originalTitleText"]) ??
      extractText(obj["titleText"]) ??
      (typeof obj["originalTitle"] === "string" ? obj["originalTitle"] : null) ??
      (typeof obj["title"] === "string" ? obj["title"] : null)

    if (title) {
      const year =
        extractYear(obj["releaseYear"]) ??
        (typeof obj["year"] === "number" ? obj["year"] : undefined)
      found.set(rawId, { title, year })
    }
  }

  for (const val of Object.values(obj)) {
    walkForTitles(val, found)
  }
}

function extractText(node: unknown): string | null {
  if (typeof node === "string") return node
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    if (typeof obj["text"] === "string") return obj["text"]
  }
  return null
}

function extractYear(node: unknown): number | undefined {
  if (typeof node === "number") return node
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    if (typeof obj["year"] === "number") return obj["year"]
  }
  return undefined
}

/**
 * Walk a JSON-LD object and collect title entries from IMDb chart/list pages.
 *
 * IMDb embeds structured data in this shape:
 *   { "@type": "ItemList", "itemListElement": [
 *     { "@type": "ListItem", "item": {
 *         "@type": "Movie", "url": "https://www.imdb.com/title/tt0111161/",
 *         "name": "The Shawshank Redemption" } },
 *     ...
 *   ] }
 *
 * Arrays and nested objects are also walked so that variant structures are
 * handled without special-casing each one.
 *
 * @internal exported for testing
 */
export function walkForTitlesFromLdJson(
  node: unknown,
  found: Map<string, { title: string; year?: number }>,
): void {
  if (!node || typeof node !== "object") return

  if (Array.isArray(node)) {
    for (const item of node) walkForTitlesFromLdJson(item, found)
    return
  }

  const obj = node as Record<string, unknown>

  // If this object has a URL pointing to an IMDb title, extract it
  const urlVal =
    typeof obj["url"] === "string"
      ? obj["url"]
      : typeof obj["@id"] === "string"
        ? obj["@id"]
        : null
  if (urlVal) {
    const idMatch = urlVal.match(IMDB_TITLE_ID_RE)
    if (idMatch) {
      const imdbId = idMatch[1]
      if (!found.has(imdbId)) {
        const title = typeof obj["name"] === "string" ? obj["name"] : null
        if (title) {
          const year = extractYearFromLdJson(obj)
          found.set(imdbId, { title, year })
        }
      }
    }
  }

  // Recurse into all values
  for (const val of Object.values(obj)) {
    walkForTitlesFromLdJson(val, found)
  }
}

/** Extract a release year from a JSON-LD object. */
function extractYearFromLdJson(obj: Record<string, unknown>): number | undefined {
  // datePublished: "1994-09-10" or "1994"
  if (typeof obj["datePublished"] === "string") {
    const y = parseInt(obj["datePublished"], 10)
    if (y > MIN_VALID_YEAR && y < MAX_VALID_YEAR) return y
  }
  if (typeof obj["startDate"] === "string") {
    const y = parseInt(obj["startDate"], 10)
    if (y > MIN_VALID_YEAR && y < MAX_VALID_YEAR) return y
  }
  return undefined
}
