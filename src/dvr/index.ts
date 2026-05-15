export interface DvrEntry {
  entryId: string
  title: string
  startTime: Date
  endTime?: Date
  channelId: string
  channelName?: string
  status: "scheduled" | "recording" | "completed" | "failed"
}

export interface DvrScheduleHints {
  eventId: string
  /** GUID hint passed to Plex DVR so the subscription links to the correct title. */
  guid?: string
  /** Title hint passed to Plex DVR so the subscription shows the correct movie name. */
  title?: string
  /** Full metadata key hint (provider path). Used by Plex DVR. */
  key?: string
  /** Plex airing channels payload from EPG metadata. */
  airingChannels?: string
  /** Plex airing times payload from EPG metadata. */
  airingTimes?: string
}

export interface DvrAdapter {
  scheduleEvent(hints: DvrScheduleHints): Promise<void>
  getScheduledEntries(): Promise<DvrEntry[]>
}
