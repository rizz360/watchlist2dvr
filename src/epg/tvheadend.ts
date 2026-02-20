import axios from "axios"
import type { EpgProvider, EpgEvent } from "./index.js"

interface TvhEpgEvent {
  eventId: number
  title: string
  start: number
  stop: number
  channelUuid: string
  channelName: string
  description?: string
  summary?: string
}

interface TvhEpgResponse {
  entries: TvhEpgEvent[]
  totalCount: number
}

export class TvheadendEpgProvider implements EpgProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  async searchByTitle(title: string): Promise<EpgEvent[]> {
    const response = await axios.get<TvhEpgResponse>(`${this.baseUrl}/api/epg/events/grid`, {
      auth: this.username ? { username: this.username, password: this.password } : undefined,
      params: {
        title,
        limit: 100,
      },
    })

    return response.data.entries.map((e) => ({
      eventId: String(e.eventId),
      title: e.title,
      startTime: new Date(e.start * 1000),
      endTime: new Date(e.stop * 1000),
      channelId: e.channelUuid,
      channelName: e.channelName,
      description: e.description ?? e.summary,
    }))
  }
}
