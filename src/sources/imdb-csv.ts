import { createReadStream, readdirSync, statSync } from "fs"
import { join } from "path"
import { createInterface } from "readline"
import type { WatchlistSource, WatchlistItem } from "./index.js"

// IMDb CSV formats (as of 2024):
//
// Watchlist: Position,Const,Created,Modified,Description,Title,URL,Title Type,
//            IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
//
// Ratings:   Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,
//            Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
//
// Detection: presence of "Your Rating" column → ratings CSV

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
      for (const item of await this.processFile(file)) {
        if (!seen.has(item.imdbId)) {
          seen.add(item.imdbId)
          items.push(item)
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

  private async processFile(filePath: string): Promise<WatchlistItem[]> {
    const lines = await this.readLines(filePath)
    if (lines.length < 2) return []

    const headers = this.parseCsvRow(lines[0]).map((h) => h.trim())
    const constIdx = headers.indexOf("Const")
    const titleIdx = headers.indexOf("Title")
    const yearIdx = headers.indexOf("Year")
    const ratingIdx = headers.indexOf("Your Rating")
    // Watchlist uses "Created", ratings use "Date Rated"
    const dateIdx =
      headers.indexOf("Created") !== -1 ? headers.indexOf("Created") : headers.indexOf("Date Rated")

    if (constIdx === -1 || titleIdx === -1) {
      console.warn(`  [imdb-csv] Skipping ${filePath} — unrecognized headers`)
      return []
    }

    const isRatings = ratingIdx !== -1
    const items: WatchlistItem[] = []

    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvRow(lines[i])
      const imdbId = cols[constIdx]?.trim()
      const title = cols[titleIdx]?.trim()
      if (!imdbId || !title || !imdbId.startsWith("tt")) continue

      if (isRatings) {
        const rating = parseInt(cols[ratingIdx], 10)
        if (isNaN(rating) || rating < this.minRating) continue
      }

      const year = yearIdx !== -1 ? parseInt(cols[yearIdx], 10) || undefined : undefined
      const addedAt = dateIdx !== -1 ? new Date(cols[dateIdx]) : new Date()

      items.push({
        imdbId,
        originalTitle: title,
        localizedTitles: {},
        year,
        addedAt: isNaN(addedAt.getTime()) ? new Date() : addedAt,
      })
    }

    return items
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

  /** Minimal RFC 4180 CSV parser (handles quoted fields with commas/newlines). */
  private parseCsvRow(line: string): string[] {
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
}
