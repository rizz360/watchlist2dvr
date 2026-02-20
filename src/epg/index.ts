export interface EpgEvent {
  eventId: string
  title: string
  startTime: Date
  endTime: Date
  channelId: string
  channelName: string
  description?: string
  year?: number
}

export interface EpgProvider {
  searchByTitle(title: string): Promise<EpgEvent[]>
}
