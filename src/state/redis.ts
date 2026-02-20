import type { Redis } from "ioredis"

const SCHEDULED_TTL = 30 * 24 * 60 * 60 // 30 days

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
}
