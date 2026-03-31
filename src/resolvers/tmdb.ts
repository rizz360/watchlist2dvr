import axios from "axios"
import https from "https"
import type { Redis } from "ioredis"

const TMDB_BASE = "https://api.themoviedb.org/3"
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const ipv4Agent = new https.Agent({ family: 4 })

interface TmdbFindResult {
  movie_results: Array<{ id: number }>
}

interface TmdbMovieDetails {
  vote_average: number
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
      const titles = JSON.parse(cached) as Record<string, string>
      titles["_fromCache"] = "1"
      return titles
    }

    let tmdbId: number | null
    if (imdbId.startsWith("tmdb:")) {
      // Item was sourced directly from TMDB — use its ID without any IMDb lookup.
      tmdbId = parseInt(imdbId.slice(5), 10)
    } else {
      tmdbId = await this.findTmdbId(imdbId)
      if (!tmdbId) {
        // Cache the empty result so we don't re-query TMDB on every run
        await this.redis.set(cacheKey, JSON.stringify({}), "EX", CACHE_TTL_SECONDS)
        return {}
      }
    }

    const response = await axios.get<{ translations: TmdbTranslation[] }>(
      `${TMDB_BASE}/movie/${tmdbId}/translations`,
      { params: { api_key: this.apiKey }, httpsAgent: ipv4Agent, timeout: 10_000 },
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

  async resolveRating(imdbId: string): Promise<number | null> {
    const cacheKey = `tmdb:rating:${imdbId}`
    const cached = await this.redis.get(cacheKey)
    if (cached) return cached === "NOT_FOUND" ? null : parseFloat(cached)

    let tmdbId: number | null
    if (imdbId.startsWith("tmdb:")) {
      tmdbId = parseInt(imdbId.slice(5), 10)
    } else {
      tmdbId = await this.findTmdbId(imdbId)
    }

    if (!tmdbId) {
      await this.redis.set(cacheKey, "NOT_FOUND", "EX", CACHE_TTL_SECONDS)
      return null
    }

    const response = await axios.get<TmdbMovieDetails>(`${TMDB_BASE}/movie/${tmdbId}`, {
      params: { api_key: this.apiKey },
      httpsAgent: ipv4Agent,
      timeout: 10_000,
    })

    const rating = response.data.vote_average ?? null
    await this.redis.set(
      cacheKey,
      rating !== null ? String(rating) : "NOT_FOUND",
      "EX",
      CACHE_TTL_SECONDS,
    )
    return rating
  }

  private async findTmdbId(imdbId: string): Promise<number | null> {
    const cacheKey = `tmdb:id:${imdbId}`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return cached === "NOT_FOUND" ? null : parseInt(cached, 10)
    }

    const response = await axios.get<TmdbFindResult>(`${TMDB_BASE}/find/${imdbId}`, {
      params: { api_key: this.apiKey, external_source: "imdb_id" },
      httpsAgent: ipv4Agent,
      timeout: 10_000,
    })

    const result = response.data.movie_results[0]
    if (!result) {
      // Negative cache: avoid re-querying on every run for movies not in TMDB
      await this.redis.set(cacheKey, "NOT_FOUND", "EX", CACHE_TTL_SECONDS)
      return null
    }

    await this.redis.set(cacheKey, String(result.id), "EX", CACHE_TTL_SECONDS)
    return result.id
  }
}
