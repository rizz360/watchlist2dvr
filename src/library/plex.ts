import axios from "axios"
import type { Redis } from "ioredis"
import type { LibraryChecker } from "./index.js"

interface PlexItem {
  guid?: string
  Guid?: Array<{ id: string }>
}

interface PlexMediaContainer {
  MediaContainer: {
    totalSize?: number
    size?: number
    Metadata?: PlexItem[]
  }
}

const CACHE_KEY = "plex:library:all"
const CACHE_TTL_SECONDS = 6 * 60 * 60 // 6 hours
const PAGE_SIZE = 1000

export class PlexLibraryChecker implements LibraryChecker {
  private idsPromise: Promise<Set<string>> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly redis: Redis,
  ) {}

  private getIds(): Promise<Set<string>> {
    if (!this.idsPromise) this.idsPromise = this.fetchIds()
    return this.idsPromise
  }

  private async fetchIds(): Promise<Set<string>> {
    const cached = await this.redis.get(CACHE_KEY)
    if (cached) {
      const ids = new Set(JSON.parse(cached) as string[])
      console.log(`  [library:plex] Loaded ${ids.size} movie(s) from cache`)
      return ids
    }

    const ids = new Set<string>()
    let start = 0
    for (;;) {
      const response = await axios.get<PlexMediaContainer>(`${this.baseUrl}/library/all`, {
        params: {
          "X-Plex-Token": this.token,
          type: 1, // 1 = Movie
          "X-Plex-Container-Start": start,
          "X-Plex-Container-Size": PAGE_SIZE,
        },
        headers: { Accept: "application/json" },
        timeout: 30_000,
      })
      const mc = response.data.MediaContainer
      const items = mc.Metadata ?? []
      for (const item of items) {
        // New Plex format: Guid array with imdb:// entries
        for (const g of item.Guid ?? []) {
          if (g.id?.startsWith("imdb://")) ids.add(g.id.slice(7))
        }
        // Legacy Plex format: single guid string "imdb://tt1234567/1/1"
        if (item.guid?.startsWith("imdb://")) {
          ids.add(item.guid.replace(/^imdb:\/\//, "").split("/")[0])
        }
      }
      start += items.length
      const total = mc.totalSize ?? items.length
      if (start >= total || items.length === 0) break
    }

    await this.redis.set(CACHE_KEY, JSON.stringify([...ids]), "EX", CACHE_TTL_SECONDS)
    console.log(`  [library:plex] Indexed ${ids.size} movie(s)`)
    return ids
  }

  async existsInLibrary(imdbId: string): Promise<boolean> {
    return (await this.getIds()).has(imdbId)
  }
}
