import { createReadStream } from "fs"
import { createInterface } from "readline"
import type { WatchlistSource, WatchlistItem } from "./index.js"

// IMDb CSV export columns (as of 2024):
// Position,Const,Created,Modified,Description,Title,URL,Title Type,IMDb Rating,
// Runtime (mins),Year,Genres,Num Votes,Release Date,Directors

export class ImdbCsvSource implements WatchlistSource {
  constructor(private readonly csvPath: string) {}

  async fetchWatchlist(): Promise<WatchlistItem[]> {
    const lines = await this.readLines(this.csvPath)
    if (lines.length < 2) return []

    const headers = this.parseCsvRow(lines[0]).map((h) => h.trim())
    const constIdx = headers.indexOf("Const")
    const titleIdx = headers.indexOf("Title")
    const yearIdx = headers.indexOf("Year")
    const createdIdx = headers.indexOf("Created")

    if (constIdx === -1 || titleIdx === -1) {
      throw new Error("IMDb CSV format not recognized — missing Const or Title columns")
    }

    const items: WatchlistItem[] = []
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvRow(lines[i])
      const imdbId = cols[constIdx]?.trim()
      const title = cols[titleIdx]?.trim()
      if (!imdbId || !title || !imdbId.startsWith("tt")) continue

      const year = yearIdx !== -1 ? parseInt(cols[yearIdx], 10) || undefined : undefined
      const addedAt = createdIdx !== -1 ? new Date(cols[createdIdx]) : new Date()

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
