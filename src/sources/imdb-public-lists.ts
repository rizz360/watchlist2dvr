import axios from "axios"
import type { WatchlistSource, WatchlistItem } from "./index.js"

// Fetches one or more public IMDb pages (charts, user lists) and extracts
// the embedded title entries — no authentication required.
//
// Supported URL patterns (anything with __NEXT_DATA__ movie entries):
//   https://www.imdb.com/chart/top/           IMDb Top 250
//   https://www.imdb.com/chart/popular/       Most popular
//   https://www.imdb.com/chart/moviemeter/    MovieMeter
//   https://www.imdb.com/list/ls000024621/    Any public user list
//
// Implementation: fetch the HTML page, parse the __NEXT_DATA__ JSON blob
// embedded by Next.js, then recursively walk the object tree to find all
// title entries (objects with an "id" matching tt\d+ and an associated title
// text). This is resilient across different IMDb page types and layouts.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

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
    try {
      const res = await axios.get<string>(url, {
        responseType: "text",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 20_000,
      })
      html = res.data
    } catch (err) {
      throw new Error(`Failed to fetch ${url}: ${(err as Error).message}`)
    }

    const ndMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
    )
    if (!ndMatch) {
      throw new Error(
        `No embedded page data found at ${url}. ` +
          `Make sure the URL is a public IMDb list or chart page.`,
      )
    }

    let data: unknown
    try {
      data = JSON.parse(ndMatch[1])
    } catch {
      throw new Error(`Failed to parse embedded page data from ${url}`)
    }

    const found = new Map<string, { title: string; year?: number }>()
    walkForTitles(data, found)

    if (found.size === 0) {
      throw new Error(
        `No movie entries found on ${url}. ` +
          `The URL may not be a list/chart page, or IMDb's page structure has changed.`,
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
