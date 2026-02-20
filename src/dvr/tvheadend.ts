import axios from "axios"
import type { DvrAdapter, DvrEntry } from "./index.js"

interface TvhDvrEntry {
  uuid: string
  disp_title: string
  start: number
  stop: number
  channel: string
  channelname?: string
  sched_status: string
}

interface TvhDvrResponse {
  entries: TvhDvrEntry[]
}

export class TvheadendDvrAdapter implements DvrAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  get auth() {
    return this.username ? { username: this.username, password: this.password } : undefined
  }

  async scheduleEvent(eventId: string): Promise<void> {
    await axios.post(
      `${this.baseUrl}/api/dvr/entry/create`,
      new URLSearchParams({ event_id: eventId, config_uuid: "" }),
      { auth: this.auth },
    )
  }

  async getScheduledEntries(): Promise<DvrEntry[]> {
    const response = await axios.get<TvhDvrResponse>(`${this.baseUrl}/api/dvr/entry/grid`, {
      auth: this.auth,
      params: { limit: 10000 },
    })

    return response.data.entries.map((e) => ({
      entryId: e.uuid,
      title: e.disp_title,
      startTime: new Date(e.start * 1000),
      endTime: e.stop ? new Date(e.stop * 1000) : undefined,
      channelId: e.channel,
      channelName: e.channelname,
      status: this.mapStatus(e.sched_status),
    }))
  }

  private mapStatus(s: string): DvrEntry["status"] {
    if (s === "scheduled") return "scheduled"
    if (s === "recording") return "recording"
    if (s === "completed") return "completed"
    return "failed"
  }
}
