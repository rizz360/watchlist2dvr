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

const CACHE_TTL_SECONDS = 6 * 60 * 60 // 6 hours

export class JellyfinLibraryChecker implements LibraryChecker {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly redis: Redis,
  ) {}

  async existsInLibrary(imdbId: string): Promise<boolean> {
    const cacheKey = `jellyfin:library:${imdbId}`
    const cached = await this.redis.get(cacheKey)
    if (cached !== null) {
      return cached === "1"
    }

    const response = await axios.get<JellyfinResponse>(`${this.baseUrl}/Items`, {
      headers: { "X-Emby-Token": this.apiKey },
      params: {
        anyProviderIdEquals: `imdb.${imdbId}`,
        IncludeItemTypes: "Movie",
        Recursive: true,
        Fields: "ProviderIds",
        Limit: 1,
      },
    })
    const exists = response.data.TotalRecordCount > 0
    await this.redis.set(cacheKey, exists ? "1" : "0", "EX", CACHE_TTL_SECONDS)
    return exists
  }
}
