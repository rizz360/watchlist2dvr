import axios from "axios"
import type { Redis } from "ioredis"

const TMDB_BASE = "https://api.themoviedb.org/3"
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

interface TmdbFindResult {
  movie_results: Array<{ id: number }>
}

interface TmdbTranslation {
  iso_639_1: string
  data: { title: string }
}

export class TmdbResolver {
  constructor(
    private readonly apiKey: string,
    private readonly redis: Redis,
  ) {}

  async resolveLocalizedTitles(imdbId: string): Promise<Record<string, string>> {
    const cacheKey = `tmdb:titles:${imdbId}`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as Record<string, string>
    }

    const tmdbId = await this.findTmdbId(imdbId)
    if (!tmdbId) {
      return {}
    }

    const response = await axios.get<{ translations: TmdbTranslation[] }>(
      `${TMDB_BASE}/movie/${tmdbId}/translations`,
      { params: { api_key: this.apiKey } },
    )

    const titles: Record<string, string> = {}
    for (const t of response.data.translations) {
      if (t.data.title) {
        titles[t.iso_639_1] = t.data.title
      }
    }

    await this.redis.set(cacheKey, JSON.stringify(titles), "EX", CACHE_TTL_SECONDS)
    return titles
  }

  private async findTmdbId(imdbId: string): Promise<number | null> {
    const cacheKey = `tmdb:id:${imdbId}`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return parseInt(cached, 10)
    }

    const response = await axios.get<TmdbFindResult>(`${TMDB_BASE}/find/${imdbId}`, {
      params: { api_key: this.apiKey, external_source: "imdb_id" },
    })

    const result = response.data.movie_results[0]
    if (!result) {
      return null
    }

    await this.redis.set(cacheKey, String(result.id), "EX", CACHE_TTL_SECONDS)
    return result.id
  }
}
