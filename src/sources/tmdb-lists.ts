import axios from "axios"
import https from "https"
import type { Redis } from "ioredis"
import type { WatchlistSource, WatchlistItem } from "./index.js"

// Fetches movies from TMDB collections, user lists, or named endpoints
// (popular, top_rated, now_playing, upcoming) and returns them as WatchlistItems.
//
// List spec formats accepted in the `lists` config array:
//   "collection:9485"   → /3/collection/9485  (franchise, e.g. Fast & Furious)
//   "collection:645"    → /3/collection/645   (e.g. James Bond)
//   "list:12345"        → /3/list/12345       (any public TMDB custom list)
//   "popular"           → /3/movie/popular    (paginated, see `pages` config)
//   "top_rated"         → /3/movie/top_rated
//   "now_playing"       → /3/movie/now_playing
//   "upcoming"          → /3/movie/upcoming
//
// Caching strategy:
//   - Each TMDB movie ID → IMDb ID mapping is cached in Redis (30-day TTL).
//     Since franchise/collection contents barely change, subsequent runs are
//     served entirely from Redis with zero TMDB API calls per movie.
//   - The scheduler's source cache (StateStore.saveSourceCache) persists the
//     full item list; on any API failure the previous successful result is
//     used automatically (the standard fallback for all sources).

const TMDB_BASE = "https://api.themoviedb.org/3"
const ipv4Agent = new https.Agent({ family: 4 })

/** How long to cache TMDB movie ID → IMDb ID mappings (30 days). */
const IMDB_ID_CACHE_TTL = 30 * 24 * 60 * 60

/** Named list endpoints supported as bare strings in the lists config. */
const NAMED_ENDPOINTS = ["popular", "top_rated", "now_playing", "upcoming"] as const
type NamedEndpoint = (typeof NAMED_ENDPOINTS)[number]

interface TmdbMovieStub {
  id: number
  title: string
  original_title: string
  release_date?: string
}

export class TmdbListsSource implements WatchlistSource {
  constructor(
    private readonly apiKey: string,
    private readonly lists: string[],
    private readonly pages: number,
    private readonly redis: Redis,
  ) {}

  async fetchWatchlist(): Promise<WatchlistItem[]> {
    const found = new Map<string, WatchlistItem>()

    for (const spec of this.lists) {
      let movies: TmdbMovieStub[]
      let label: string
      try {
        const result = await this.fetchSpec(spec)
        movies = result.movies
        label = result.label
      } catch (err) {
        console.warn(`  [tmdb-lists] Failed to fetch "${spec}": ${(err as Error).message}`)
        continue
      }

      let resolved = 0
      for (const movie of movies) {
        let imdbId: string | null
        try {
          imdbId = await this.resolveImdbId(movie.id)
        } catch {
          continue // skip movies whose imdb_id lookup fails
        }
        if (!imdbId || found.has(imdbId)) continue

        const rawYear = movie.release_date ? parseInt(movie.release_date.slice(0, 4), 10) : NaN
        found.set(imdbId, {
          imdbId,
          originalTitle: movie.original_title || movie.title,
          localizedTitles: {},
          year: Number.isNaN(rawYear) ? undefined : rawYear,
          addedAt: new Date(),
          source: "list",
          listLabel: label,
        })
        resolved++
      }
      console.log(`  [tmdb-lists] ${spec}: ${resolved}/${movies.length} movie(s) resolved`)
    }

    return [...found.values()]
  }

  // ---------------------------------------------------------------------------

  private async fetchSpec(spec: string): Promise<{ movies: TmdbMovieStub[]; label: string }> {
    if (spec.startsWith("collection:")) {
      const id = spec.slice("collection:".length)
      return this.fetchCollection(id)
    }
    if (spec.startsWith("list:")) {
      const id = spec.slice("list:".length)
      return this.fetchTmdbList(id)
    }
    if ((NAMED_ENDPOINTS as readonly string[]).includes(spec)) {
      return this.fetchNamed(spec as NamedEndpoint)
    }
    throw new Error(
      `Unknown TMDB list spec: "${spec}". ` +
        `Use collection:<id>, list:<id>, or one of: ${NAMED_ENDPOINTS.join(", ")}`,
    )
  }

  private async fetchCollection(id: string): Promise<{ movies: TmdbMovieStub[]; label: string }> {
    const res = await axios.get<{ name: string; parts: TmdbMovieStub[] }>(
      `${TMDB_BASE}/collection/${id}`,
      { params: { api_key: this.apiKey }, httpsAgent: ipv4Agent, timeout: 10_000 },
    )
    return {
      movies: res.data.parts ?? [],
      label: res.data.name || `TMDB Collection ${id}`,
    }
  }

  private async fetchTmdbList(id: string): Promise<{ movies: TmdbMovieStub[]; label: string }> {
    const res = await axios.get<{
      name: string
      items: Array<TmdbMovieStub & { media_type?: string }>
    }>(`${TMDB_BASE}/list/${id}`, {
      params: { api_key: this.apiKey },
      httpsAgent: ipv4Agent,
      timeout: 10_000,
    })
    const movies = (res.data.items ?? []).filter(
      (i) => !i.media_type || i.media_type === "movie",
    )
    return {
      movies,
      label: res.data.name || `TMDB List ${id}`,
    }
  }

  private async fetchNamed(name: NamedEndpoint): Promise<{ movies: TmdbMovieStub[]; label: string }> {
    const LABELS: Record<NamedEndpoint, string> = {
      popular: "TMDB Popular",
      top_rated: "TMDB Top Rated",
      now_playing: "TMDB Now Playing",
      upcoming: "TMDB Upcoming",
    }
    const results: TmdbMovieStub[] = []
    for (let page = 1; page <= this.pages; page++) {
      const res = await axios.get<{
        results: TmdbMovieStub[]
        total_pages: number
      }>(`${TMDB_BASE}/movie/${name}`, {
        params: { api_key: this.apiKey, page },
        httpsAgent: ipv4Agent,
        timeout: 10_000,
      })
      results.push(...(res.data.results ?? []))
      if (page >= res.data.total_pages) break
    }
    return { movies: results, label: LABELS[name] }
  }

  /** Resolve a TMDB movie ID to its IMDb ID, with Redis caching. */
  private async resolveImdbId(tmdbId: number): Promise<string | null> {
    const cacheKey = `tmdb:ext:${tmdbId}`
    const cached = await this.redis.get(cacheKey)
    if (cached !== null) return cached === "NOT_FOUND" ? null : cached

    const res = await axios.get<{ imdb_id?: string | null }>(
      `${TMDB_BASE}/movie/${tmdbId}/external_ids`,
      { params: { api_key: this.apiKey }, httpsAgent: ipv4Agent, timeout: 10_000 },
    )
    const imdbId = res.data.imdb_id || null
    await this.redis.set(cacheKey, imdbId ?? "NOT_FOUND", "EX", IMDB_ID_CACHE_TTL)
    // Pre-seed the TmdbResolver reverse-lookup cache (tmdb:id:{imdbId} → tmdbId)
    // so that resolveLocalizedTitles() never has to call /find/{imdbId} for these movies.
    if (imdbId) {
      await this.redis.set(`tmdb:id:${imdbId}`, String(tmdbId), "EX", IMDB_ID_CACHE_TTL)
    }
    return imdbId
  }
}
