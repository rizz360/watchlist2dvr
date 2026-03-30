import type { Redis } from "ioredis"

export interface RunMatch {
  imdbId: string
  originalTitle: string
  localizedTitle?: string
  source: "watchlist" | "rating" | "list"
  listLabel?: string
  userRating?: number
  epgTitle: string
  channelName: string
  startTime: string
  confidence: "exact" | "suffix" | "fuzzy"
  matchedLanguage: string
}

export interface RunAmbiguous {
  imdbId: string
  originalTitle: string
  localizedTitle?: string
  source: "watchlist" | "rating" | "list"
  listLabel?: string
  userRating?: number
  reason: string
}

export interface RunUnmatched {
  imdbId: string
  originalTitle: string
  localizedTitle?: string
  source: "watchlist" | "rating" | "list"
  listLabel?: string
  userRating?: number
  year?: number
}

export interface RunRecord {
  id: string
  startedAt: string
  completedAt: string
  dryRun: boolean
  itemsTotal: number
  itemsInLibrary: number
  itemsAlreadyScheduled: number
  matchesFound: number
  scheduled: number
  ambiguous: number
  unmatched: number
  errors: string[]
  matches: RunMatch[]
  ambiguousItems: RunAmbiguous[]
  unmatchedItems: RunUnmatched[]
  inLibraryItems: Array<{ imdbId: string; originalTitle: string; source: "watchlist" | "rating" | "list"; listLabel?: string; userRating?: number }>
  alreadyScheduledItems: Array<{ imdbId: string; originalTitle: string; source: "watchlist" | "rating" | "list"; listLabel?: string; userRating?: number }>
}

const HISTORY_KEY = "history:runs"
const HISTORY_MAX = 50

export class HistoryStore {
  constructor(private readonly redis: Redis) {}

  async saveRun(record: RunRecord): Promise<void> {
    await this.redis.lpush(HISTORY_KEY, JSON.stringify(record))
    await this.redis.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1)
  }

  async getRuns(limit = 20): Promise<RunRecord[]> {
    const raw = await this.redis.lrange(HISTORY_KEY, 0, limit - 1)
    return raw.map((r) => JSON.parse(r) as RunRecord)
  }

  async getLastRun(): Promise<RunRecord | null> {
    const runs = await this.getRuns(1)
    return runs[0] ?? null
  }
}
