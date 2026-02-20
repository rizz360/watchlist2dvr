export interface WatchlistItem {
  imdbId: string
  originalTitle: string
  localizedTitles: Record<string, string>
  year?: number
  addedAt: Date
  source: "watchlist" | "rating"
  userRating?: number
}

export interface WatchlistSource {
  fetchWatchlist(): Promise<WatchlistItem[]>
}
