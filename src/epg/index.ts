export interface EpgEvent {
  eventId: string
  /** GUID as returned by the EPG provider (e.g. `tv.plex.xmltv://movie/...`). Used by Plex DVR. */
  guid?: string
  /** Full metadata key path as returned by the EPG provider. Used by Plex DVR. */
  key?: string
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
