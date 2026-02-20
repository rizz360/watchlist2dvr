import axios from "axios"
import type { Redis } from "ioredis"
import type { LibraryChecker } from "./index.js"

interface JellyfinItem {
  ProviderIds?: { Imdb?: string }
}

interface JellyfinResponse {
  Items: JellyfinItem[]
  TotalRecordCount: number
}

const CACHE_KEY = "jellyfin:library:all"
const CACHE_TTL_SECONDS = 6 * 60 * 60 // 6 hours
const PAGE_SIZE = 1000

export class JellyfinLibraryChecker implements LibraryChecker {
  private idsPromise: Promise<Set<string>> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
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
      console.log(`  [library:jellyfin] Loaded ${ids.size} movie(s) from cache`)
      return ids
    }

    const ids = new Set<string>()
    let startIndex = 0
    for (;;) {
      const response = await axios.get<JellyfinResponse>(`${this.baseUrl}/Items`, {
        headers: { "X-Emby-Token": this.apiKey },
        params: {
          IncludeItemTypes: "Movie",
          Recursive: true,
          Fields: "ProviderIds",
          StartIndex: startIndex,
          Limit: PAGE_SIZE,
        },
        timeout: 30_000,
      })
      const { Items, TotalRecordCount } = response.data
      for (const item of Items) {
        const imdb = item.ProviderIds?.Imdb
        if (imdb) ids.add(imdb)
      }
      startIndex += Items.length
      if (startIndex >= TotalRecordCount || Items.length === 0) break
    }

    await this.redis.set(CACHE_KEY, JSON.stringify([...ids]), "EX", CACHE_TTL_SECONDS)
    console.log(`  [library:jellyfin] Indexed ${ids.size} movie(s)`)
    return ids
  }

  async existsInLibrary(imdbId: string): Promise<boolean> {
    return (await this.getIds()).has(imdbId)
  }
}
