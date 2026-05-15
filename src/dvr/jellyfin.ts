import axios from "axios"
import type { DvrAdapter, DvrEntry, DvrScheduleHints } from "./index.js"

interface JellyfinProgram {
  Id: string
  Name?: string
  Overview?: string
  StartDate?: string
  EndDate?: string
  ChannelId?: string
  ChannelName?: string
  ExternalProgramId?: string
  ServerId?: string
  ServiceName?: string
  ImageTags?: Record<string, string>
}

interface JellyfinProgramsResponse {
  Items?: JellyfinProgram[]
}

interface JellyfinTimer {
  Id: string
  ProgramId?: string
  Name?: string
  StartDate?: string
  EndDate?: string
  ChannelId?: string
  ChannelName?: string
  Status?: string
}

interface JellyfinTimersResponse {
  Items?: JellyfinTimer[]
}

export class JellyfinDvrAdapter implements DvrAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private get headers() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Emby-Token": this.apiKey,
    }
  }

  private async getProgram(programId: string): Promise<JellyfinProgram | null> {
    try {
      const byId = await axios.get<JellyfinProgram>(`${this.baseUrl}/LiveTv/Programs/${programId}`, {
        headers: this.headers,
        timeout: 15_000,
      })
      if (byId.data?.Id) return byId.data
    } catch {
      // fall through to list lookup
    }

    const list = await axios.get<JellyfinProgramsResponse>(`${this.baseUrl}/LiveTv/Programs`, {
      headers: this.headers,
      params: { Ids: programId, Limit: 1 },
      timeout: 15_000,
    })
    return (list.data.Items ?? []).find((p) => p.Id === programId) ?? null
  }

  async scheduleEvent(hints: DvrScheduleHints): Promise<void> {
    const program = await this.getProgram(hints.eventId)

    const body = {
      RecordAnyTime: true,
      SkipEpisodesInLibrary: true,
      RecordAnyChannel: false,
      KeepUpTo: 0,
      RecordNewOnly: true,
      Days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      DayPattern: "Daily",
      ImageTags: program?.ImageTags ?? {},
      Id: hints.eventId,
      Type: "SeriesTimer",
      ServerId: hints.serverId ?? program?.ServerId,
      ChannelId: hints.channelId ?? program?.ChannelId,
      ChannelName: hints.channelName ?? program?.ChannelName,
      ProgramId: hints.eventId,
      ExternalProgramId: hints.externalProgramId ?? program?.ExternalProgramId,
      Name: hints.title ?? program?.Name ?? "",
      Overview: hints.description ?? program?.Overview ?? "",
      StartDate: hints.startTime?.toISOString() ?? program?.StartDate,
      EndDate: hints.endTime?.toISOString() ?? program?.EndDate,
      ServiceName: hints.serviceName ?? program?.ServiceName ?? "Emby",
      Priority: 0,
      PrePaddingSeconds: 0,
      PostPaddingSeconds: 0,
      IsPrePaddingRequired: false,
      IsPostPaddingRequired: false,
      KeepUntil: "UntilDeleted",
    }

    await axios.post(`${this.baseUrl}/LiveTv/SeriesTimers`, body, {
      headers: this.headers,
      timeout: 15_000,
    })
  }

  async getScheduledEntries(): Promise<DvrEntry[]> {
    const resp = await axios.get<JellyfinTimersResponse>(`${this.baseUrl}/LiveTv/Timers`, {
      headers: this.headers,
      params: { Limit: 10000 },
      timeout: 15_000,
    })

    return (resp.data.Items ?? []).map((t) => ({
      entryId: t.ProgramId ?? t.Id,
      title: t.Name ?? "",
      startTime: t.StartDate ? new Date(t.StartDate) : new Date(0),
      endTime: t.EndDate ? new Date(t.EndDate) : undefined,
      channelId: t.ChannelId ?? "",
      channelName: t.ChannelName,
      status: this.mapStatus(t.Status),
    }))
  }

  private mapStatus(status?: string): DvrEntry["status"] {
    if (!status) return "scheduled"
    const s = status.toLowerCase()
    if (s.includes("recording")) return "recording"
    if (s.includes("complete") || s.includes("completed")) return "completed"
    if (s.includes("error") || s.includes("cancel") || s.includes("fail")) return "failed"
    return "scheduled"
  }
}
