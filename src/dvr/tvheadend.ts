import axios from "axios"
import type { DvrAdapter, DvrEntry, DvrScheduleHints } from "./index.js"

interface TvhDvrEntry {
  uuid: string
  disp_title: string
  start: number
  stop: number
  channel: string
  channelname?: string
  sched_status?: string
}

interface TvhDvrConfig {
  uuid: string
  name: string
  enabled?: boolean
}

interface TvhDvrResponse {
  entries: TvhDvrEntry[]
}

interface TvhDvrConfigResponse {
  entries: TvhDvrConfig[]
}

export class TvheadendDvrAdapter implements DvrAdapter {
  private configUuidPromise: Promise<string | null> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  get auth() {
    return this.username ? { username: this.username, password: this.password } : undefined
  }

  private getConfigUuid(): Promise<string | null> {
    if (!this.configUuidPromise) {
      this.configUuidPromise = this.fetchConfigUuid().catch((err) => {
        this.configUuidPromise = null
        throw err
      })
    }
    return this.configUuidPromise
  }

  private async fetchConfigUuid(): Promise<string | null> {
    const response = await axios.get<TvhDvrConfigResponse>(`${this.baseUrl}/api/dvr/config/grid`, {
      auth: this.auth,
      params: { limit: 100 },
      timeout: 10_000,
    })
    const entries = response.data.entries ?? []
    if (entries.length === 0) return null

    const defaultEntry = entries.find((e) => e.name === "" && e.enabled !== false)
    if (defaultEntry?.uuid) return defaultEntry.uuid

    const firstEnabled = entries.find((e) => e.enabled !== false)
    if (firstEnabled?.uuid) return firstEnabled.uuid

    return entries[0]?.uuid ?? null
  }

  async scheduleEvent({ eventId }: DvrScheduleHints): Promise<void> {
    const configUuid = await this.getConfigUuid()
    await axios.post(
      `${this.baseUrl}/api/dvr/entry/create_by_event`,
      null,
      {
        auth: this.auth,
        params: {
          event_id: eventId,
          ...(configUuid ? { config_uuid: configUuid } : {}),
        },
        timeout: 10_000,
      },
    )
  }

  async getScheduledEntries(): Promise<DvrEntry[]> {
    const response = await axios.get<TvhDvrResponse>(`${this.baseUrl}/api/dvr/entry/grid_upcoming`, {
      auth: this.auth,
      params: { limit: 10000, duplicates: 0 },
      timeout: 10_000,
    })

    return response.data.entries.map((e) => ({
      entryId: e.uuid,
      title: e.disp_title,
      startTime: new Date(e.start * 1000),
      endTime: e.stop ? new Date(e.stop * 1000) : undefined,
      channelId: e.channel,
      channelName: e.channelname,
      status: this.mapStatus(e.sched_status ?? ""),
    }))
  }

  private mapStatus(s: string): DvrEntry["status"] {
    if (!s) return "failed"
    if (s === "scheduled") return "scheduled"
    if (s === "recording") return "recording"
    if (s.startsWith("completed")) return "completed"
    return "failed"
  }
}
