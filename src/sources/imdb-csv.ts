import { createReadStream, readdirSync, statSync } from "fs"
import { join } from "path"
import { createInterface } from "readline"
import type { WatchlistSource, WatchlistItem } from "./index.js"

// IMDb CSV export formats (as of 2025):
//
// Both watchlist and ratings exports share the same column schema:
//   Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,
//   IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated
//
// Source is detected per row: a filled "Your Rating" cell → "rating", otherwise → "watchlist".
// "Title Type" is used to filter out non-movies (Video Game, tvSeries, etc.).
// "Original Title" (native language) is used as originalTitle; "Title" (English display name)
// is pre-seeded as localizedTitles["en"] when it differs.

/** Minimal RFC 4180 CSV parser (handles quoted fields with embedded commas/quotes). */
function parseCsvRow(line: string): string[] {
  const cols: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === "," && !inQuotes) {
      cols.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  cols.push(current)
  return cols
}

function parseImdbLines(lines: string[], minRating: number): WatchlistItem[] {
  if (lines.length < 2) return []

  const headers = parseCsvRow(lines[0]).map((h) => h.trim())
  const constIdx = headers.indexOf("Const")
  const titleIdx = headers.indexOf("Title")
  const origTitleIdx = headers.indexOf("Original Title")
  const titleTypeIdx = headers.indexOf("Title Type")
  const yearIdx = headers.indexOf("Year")
  const ratingIdx = headers.indexOf("Your Rating")
  const dateIdx =
    headers.indexOf("Created") !== -1 ? headers.indexOf("Created") : headers.indexOf("Date Rated")

  if (constIdx === -1 || titleIdx === -1) return []

  const items: WatchlistItem[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const cols = parseCsvRow(line)
    const imdbId = cols[constIdx]?.trim()
    const title = cols[titleIdx]?.trim()
    if (!imdbId || !title || !imdbId.startsWith("tt")) continue

    // Only record movies — skip Video Games, TV series, shorts, etc.
    if (titleTypeIdx !== -1) {
      const titleType = cols[titleTypeIdx]?.trim()
      if (titleType && titleType !== "Movie" && titleType !== "TV Movie") continue
    }

    // Per-row source and rating detection
    const ratingRaw = ratingIdx !== -1 ? cols[ratingIdx]?.trim() : ""
    const userRatingParsed = ratingRaw ? parseInt(ratingRaw, 10) : NaN
    const source: "watchlist" | "rating" = !isNaN(userRatingParsed) ? "rating" : "watchlist"
    const userRating = source === "rating" ? userRatingParsed : undefined

    // Apply min_rating filter only to rated rows
    if (source === "rating" && userRating! < minRating) continue

    // Use "Original Title" (native language) as canonical title
    // Pre-seed English display title so matching engine can try both
    const origTitle = origTitleIdx !== -1 ? cols[origTitleIdx]?.trim() : undefined
    const originalTitle = origTitle || title
    const localizedTitles: Record<string, string> = {}
    if (origTitle && title && origTitle !== title) {
      localizedTitles["en"] = title
    }

    const year = yearIdx !== -1 ? parseInt(cols[yearIdx], 10) || undefined : undefined
    const addedAt = dateIdx !== -1 ? new Date(cols[dateIdx]) : new Date()

    items.push({
      imdbId,
      originalTitle,
      localizedTitles,
      year,
      addedAt: isNaN(addedAt.getTime()) ? new Date() : addedAt,
      source,
      userRating,
    })
  }

  return items
}

/**
 * Parse an IMDb CSV export from raw text (watchlist or ratings).
 * Exported for use by ImdbAutoSource which downloads CSV over HTTP.
 */
export function parseImdbCsvText(text: string, minRating: number = 1): WatchlistItem[] {
  // Strip UTF-8 BOM if present
  const clean = text.replace(/^\uFEFF/, "")
  return parseImdbLines(clean.split(/\r?\n/), minRating)
}

export class ImdbCsvSource implements WatchlistSource {
  constructor(
    private readonly csvPath: string,
    private readonly minRating: number = 1,
  ) {}

  async fetchWatchlist(): Promise<WatchlistItem[]> {
    const files = this.resolveFiles()
    const seen = new Set<string>()
    const items: WatchlistItem[] = []

    for (const file of files) {
      const lines = await this.readLines(file)
      if (lines.length >= 2) {
        const headers = parseCsvRow(lines[0]).map((h) => h.trim())
        if (headers.indexOf("Const") === -1 || headers.indexOf("Title") === -1) {
          console.warn(`  [imdb-csv] Skipping ${file} — unrecognized headers`)
          continue
        }
      }
      for (const item of parseImdbLines(lines, this.minRating)) {
        if (!seen.has(item.imdbId)) {
          seen.add(item.imdbId)
          items.push({
            ...item,
            listLabel: item.source === "rating" ? "IMDb Ratings (CSV)" : "IMDb Watchlist (CSV)",
          })
        }
      }
    }

    return items
  }

  private resolveFiles(): string[] {
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.csvPath)
    } catch {
      throw new Error(`IMDb CSV path not found: ${this.csvPath}`)
    }
    if (stat.isDirectory()) {
      return readdirSync(this.csvPath)
        .filter((f) => f.toLowerCase().endsWith(".csv"))
        .sort()
        .map((f) => join(this.csvPath, f))
    }
    return [this.csvPath]
  }

  private readLines(path: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const lines: string[] = []
      const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
      rl.on("line", (line) => lines.push(line))
      rl.on("close", () => resolve(lines))
      rl.on("error", reject)
    })
  }
}
