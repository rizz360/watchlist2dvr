export interface WatchlistItem {
  imdbId: string
  originalTitle: string
  localizedTitles: Record<string, string>
  year?: number
  addedAt: Date
}

export interface WatchlistSource {
  fetchWatchlist(): Promise<WatchlistItem[]>
}
