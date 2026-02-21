import axios from "axios"
import type { WatchlistSource, WatchlistItem } from "./index.js"

interface TraktWatchlistEntry {
  movie: {
    title: string
    year?: number
    ids: {
      imdb: string
    }
  }
  listed_at: string
}

export class TraktSource implements WatchlistSource {
  private readonly baseUrl = "https://api.trakt.tv"

  constructor(
    private readonly clientId: string,
    private readonly username: string,
  ) {}

  async fetchWatchlist(): Promise<WatchlistItem[]> {
    const response = await axios.get<TraktWatchlistEntry[]>(
      `${this.baseUrl}/users/${this.username}/watchlist/movies`,
      {
        headers: {
          "trakt-api-version": "2",
          "trakt-api-key": this.clientId,
        },
        timeout: 10_000,
      },
    )

    return response.data
      .filter((entry) => !!entry.movie.ids.imdb)
      .map((entry) => ({
        imdbId: entry.movie.ids.imdb,
        originalTitle: entry.movie.title,
        localizedTitles: {},
        year: entry.movie.year,
        addedAt: new Date(entry.listed_at),
        source: "watchlist" as const,
        listLabel: "Trakt Watchlist",
      }))
  }
}
