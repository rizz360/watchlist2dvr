import type { Redis } from "ioredis"
import type { WatchlistItem } from "../sources/index.js"

const SCHEDULED_TTL = 30 * 24 * 60 * 60 // 30 days
const WATCHLIST_CACHE_TTL = 7 * 24 * 60 * 60 // 7 days

export class StateStore {
  constructor(private readonly redis: Redis) {}

  async isScheduled(imdbId: string): Promise<boolean> {
    const val = await this.redis.get(`state:scheduled:${imdbId}`)
    return val !== null
  }

  async markScheduled(imdbId: string): Promise<void> {
    await this.redis.set(`state:scheduled:${imdbId}`, "1", "EX", SCHEDULED_TTL)
  }

  async isSkipped(imdbId: string): Promise<boolean> {
    const val = await this.redis.get(`state:skipped:${imdbId}`)
    return val !== null
  }

  async markSkipped(imdbId: string, reason: string): Promise<void> {
    await this.redis.set(`state:skipped:${imdbId}`, reason, "EX", SCHEDULED_TTL)
  }

  /** Persist the watchlist items for a source so they can be used if the next fetch fails. */
  async saveSourceCache(sourceId: string, items: WatchlistItem[]): Promise<void> {
    const key = `watchlist-cache:${sourceId}`
    await this.redis.set(key, JSON.stringify(items), "EX", WATCHLIST_CACHE_TTL)
  }

  /** Return the last successfully cached items for a source, or null if none exist. */
  async loadSourceCache(sourceId: string): Promise<WatchlistItem[] | null> {
    const key = `watchlist-cache:${sourceId}`
    const val = await this.redis.get(key)
    if (!val) return null
    const raw = JSON.parse(val) as Array<Record<string, unknown>>
    return raw.map((item) => ({
      // Data was saved as JSON from a valid WatchlistItem; re-hydrate Date field.
      ...(item as unknown as WatchlistItem),
      addedAt: new Date(item["addedAt"] as string),
    }))
  }
}
