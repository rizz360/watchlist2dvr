import axios from "axios"
import type { Redis } from "ioredis"
import type { LibraryChecker } from "./index.js"

interface PlexSection {
  key: string
  type: string
}

interface PlexSectionsContainer {
  MediaContainer: {
    Directory?: PlexSection[]
  }
}

interface PlexItem {
  guid?: string
  Guid?: Array<{ id: string }>
}

interface PlexLibraryContainer {
  MediaContainer: {
    totalSize?: number
    size?: number
    Metadata?: PlexItem[]
  }
}

const CACHE_KEY = "plex:library:all:v2"
const CACHE_TTL_SECONDS = 6 * 60 * 60 // 6 hours
const PAGE_SIZE = 500

export class PlexLibraryChecker implements LibraryChecker {
  private idsPromise: Promise<Set<string>> | null = null
  private idsFetchedAt: number | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly redis: Redis,
  ) {}

  private getIds(): Promise<Set<string>> {
    // Expire in-memory cache after TTL so library additions are picked up
    // and so a previously-failed fetch is retried
    if (this.idsPromise && this.idsFetchedAt && Date.now() - this.idsFetchedAt > CACHE_TTL_SECONDS * 1000) {
      this.idsPromise = null
      this.idsFetchedAt = null
    }
    if (!this.idsPromise) {
      this.idsPromise = this.fetchIds().then(
        (ids) => { this.idsFetchedAt = Date.now(); return ids },
        (err) => {
          // Reset so the next run retries instead of reusing the rejected promise
          this.idsPromise = null
          this.idsFetchedAt = null
          throw err
        },
      )
    }
    return this.idsPromise
  }

  private get authParams() {
    return { "X-Plex-Token": this.token }
  }

  private async fetchIds(): Promise<Set<string>> {
    const cached = await this.redis.get(CACHE_KEY)
    if (cached) {
      const ids = new Set(JSON.parse(cached) as string[])
      console.log(`  [library:plex] Loaded ${ids.size} movie(s) from cache`)
      return ids
    }

    // 1. Find all movie library section keys
    const sectionsResp = await axios.get<PlexSectionsContainer>(
      `${this.baseUrl}/library/sections`,
      { params: this.authParams, headers: { Accept: "application/json" }, timeout: 15_000 },
    )
    const movieSections = (sectionsResp.data.MediaContainer.Directory ?? []).filter(
      (s) => s.type === "movie",
    )

    if (movieSections.length === 0) {
      console.warn("  [library:plex] No movie library sections found")
      return new Set()
    }

    // 2. Fetch all movies from each section with pagination
    const ids = new Set<string>()
    for (const section of movieSections) {
      let start = 0
      for (;;) {
        const resp = await axios.get<PlexLibraryContainer>(
          `${this.baseUrl}/library/sections/${section.key}/all`,
          {
            params: {
              ...this.authParams,
              type: 1, // Movie
              includeGuids: 1,
              "X-Plex-Container-Start": start,
              "X-Plex-Container-Size": PAGE_SIZE,
            },
            headers: { Accept: "application/json" },
            timeout: 30_000,
          },
        )
        const mc = resp.data.MediaContainer
        const items = mc.Metadata ?? []
        for (const item of items) {
          // New Plex format: Guid[] with "imdb://ttXXX" and "tmdb://12345" entries
          for (const g of item.Guid ?? []) {
            if (g.id?.startsWith("imdb://")) ids.add(g.id.slice(7))
            else if (g.id?.startsWith("tmdb://")) ids.add(`tmdb:${g.id.slice(7)}`)
          }
          // Legacy Plex format: guid = "com.plexapp.agents.imdb://ttXXX?lang=..."
          if (item.guid) {
            const m = item.guid.match(/imdb:\/\/(tt\d+)/)
            if (m) ids.add(m[1])
          }
        }
        start += items.length
        const total = mc.totalSize ?? mc.size ?? items.length
        if (start >= total || items.length === 0) break
      }
    }

    if (ids.size > 0) {
      await this.redis.set(CACHE_KEY, JSON.stringify([...ids]), "EX", CACHE_TTL_SECONDS)
    }
    console.log(`  [library:plex] Indexed ${ids.size} movie(s)`)
    return ids
  }

  async existsInLibrary(imdbId: string): Promise<boolean> {
    return (await this.getIds()).has(imdbId)
  }
}
