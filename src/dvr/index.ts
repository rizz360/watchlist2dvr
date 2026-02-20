export interface DvrEntry {
  entryId: string
  title: string
  startTime: Date
  endTime?: Date
  channelId: string
  channelName?: string
  status: "scheduled" | "recording" | "completed" | "failed"
}

export interface DvrAdapter {
  scheduleEvent(eventId: string): Promise<void>
  getScheduledEntries(): Promise<DvrEntry[]>
}
