export interface EpgEvent {
  eventId: string
  /** GUID as returned by the EPG provider (e.g. `tv.plex.xmltv://movie/...`). Used by Plex DVR. */
  guid?: string
  /** Full metadata key path as returned by the EPG provider. Used by Plex DVR. */
  key?: string
  /** Plex airing channel payload (e.g. `<channelIdentifier>=<urlencoded channel label>`). */
  airingChannels?: string
  /** Plex airing time payload as comma-separated epoch seconds: `start,end,start,end,...`. */
  airingTimes?: string
  /** Jellyfin external program id. */
  externalProgramId?: string
  /** Jellyfin server id associated with the program. */
  serverId?: string
  /** Jellyfin backend service name (often `Emby`). */
  serviceName?: string
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
