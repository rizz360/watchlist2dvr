export interface DvrEntry {
  entryId: string
  title: string
  startTime: Date
  channelId: string
  status: "scheduled" | "recording" | "completed" | "failed"
}

export interface DvrAdapter {
  scheduleEvent(eventId: string): Promise<void>
  getScheduledEntries(): Promise<DvrEntry[]>
}
