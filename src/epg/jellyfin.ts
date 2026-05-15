import axios from "axios"
import type { EpgEvent, EpgProvider } from "./index.js"

interface JellyfinProgram {
  Id: string
  Name: string
  Overview?: string
  StartDate?: string
  EndDate?: string
  ChannelId?: string
  ChannelName?: string
  ExternalProgramId?: string
  ServerId?: string
  ServiceName?: string
}

interface JellyfinProgramsResponse {
  Items?: JellyfinProgram[]
}

export class JellyfinEpgProvider implements EpgProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async searchByTitle(title: string): Promise<EpgEvent[]> {
    const resp = await axios.get<JellyfinProgramsResponse>(`${this.baseUrl}/Items`, {
      headers: {
        Accept: "application/json",
        "X-Emby-Token": this.apiKey,
      },
      params: {
        searchTerm: title,
        limit: 100,
        recursive: true,
        includeItemTypes: "LiveTvProgram",
        isMovie: false,
        isSeries: false,
        isNews: false,
        isKids: false,
        isSports: false,
        imageTypeLimit: 1,
        enableTotalRecordCount: false,
      },
      timeout: 30_000,
    })

    const items = resp.data.Items ?? []
    return items.flatMap((p): EpgEvent[] => {
      if (!p.Id || !p.Name || !p.StartDate) return []
      const start = new Date(p.StartDate)
      const end = p.EndDate ? new Date(p.EndDate) : new Date(start)
      return [{
        eventId: p.Id,
        externalProgramId: p.ExternalProgramId,
        serverId: p.ServerId,
        serviceName: p.ServiceName,
        title: p.Name,
        startTime: start,
        endTime: end,
        channelId: p.ChannelId ?? "",
        channelName: p.ChannelName ?? "",
        description: p.Overview,
      }]
    })
  }
}
