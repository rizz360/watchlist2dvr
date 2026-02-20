import axios from "axios"
import type { Redis } from "ioredis"
import type { LibraryChecker } from "./index.js"

interface PlexMediaContainer {
  MediaContainer: {
    totalSize?: number
    size?: number
    Metadata?: Array<{ guid?: string; Guid?: Array<{ id: string }> }>
  }
}

const CACHE_TTL_SECONDS = 6 * 60 * 60 // 6 hours

export class PlexLibraryChecker implements LibraryChecker {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly redis: Redis,
  ) {}

  async existsInLibrary(imdbId: string): Promise<boolean> {
    const cacheKey = `plex:library:${imdbId}`
    const cached = await this.redis.get(cacheKey)
    if (cached !== null) {
      return cached === "1"
    }

    // Plex uses "imdb://ttXXXXXX" as a GUID
    const guid = `imdb://${imdbId}`
    const response = await axios.get<PlexMediaContainer>(`${this.baseUrl}/library/all`, {
      params: {
        "X-Plex-Token": this.token,
        type: 1, // 1 = Movie
        guid,
      },
      headers: { Accept: "application/json" },
      timeout: 10_000,
    })
    const mc = response.data.MediaContainer
    const exists = (mc.totalSize ?? mc.size ?? mc.Metadata?.length ?? 0) > 0
    await this.redis.set(cacheKey, exists ? "1" : "0", "EX", CACHE_TTL_SECONDS)
    return exists
  }
}
