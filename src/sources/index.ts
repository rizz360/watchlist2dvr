export interface WatchlistItem {
  imdbId: string
  originalTitle: string
  localizedTitles: Record<string, string>
  year?: number
  addedAt: Date
  source: "watchlist" | "rating" | "list"
  userRating?: number
  /** Human-readable label for the originating list, e.g. "IMDb Watchlist", "IMDb Top 250" */
  listLabel?: string
}

export interface WatchlistSource {
  fetchWatchlist(): Promise<WatchlistItem[]>
}
