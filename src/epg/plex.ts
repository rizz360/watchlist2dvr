import axios from "axios"
import http from "http"
import type { EpgProvider, EpgEvent } from "./index.js"

interface PlexMediaProvider {
  identifier: string
  Feature?: Array<{ type: string }>
}

interface PlexProvidersContainer {
  MediaContainer: {
    MediaProvider?: PlexMediaProvider[]
  }
}

interface PlexEpgItem {
  ratingKey: string
  title: string
  year?: number
  summary?: string
  Media?: Array<{
    channelIdentifier?: string
    channelCallLetters?: string
    channelTitle?: string
    beginsAt?: number // epoch seconds
    endsAt?: number // epoch seconds
  }>
}

interface PlexEpgContainer {
  MediaContainer: {
    Metadata?: PlexEpgItem[]
  }
}

export class PlexEpgProvider implements EpgProvider {
  // Cached promise — provider discovery happens once per process lifetime
  private providerIdPromise: Promise<string | null> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly staticProviderId?: string,
  ) {}

  private get authParams() {
    return { "X-Plex-Token": this.token }
  }

  private getProviderId(): Promise<string | null> {
    if (this.staticProviderId) {
      if (!this.providerIdPromise) {
        console.log(`  [epg:plex] Using static provider: ${this.staticProviderId}`)
        this.providerIdPromise = Promise.resolve(this.staticProviderId)
      }
      return this.providerIdPromise
    }
    if (!this.providerIdPromise) {
      this.providerIdPromise = this.fetchProviderId().catch((err) => {
        this.providerIdPromise = null // reset so next call retries
        throw err
      })
    }
    return this.providerIdPromise
  }

  private async fetchProviderId(): Promise<string | null> {
    const resp = await axios.get<PlexProvidersContainer>(`${this.baseUrl}/media/providers`, {
      params: this.authParams,
      headers: { Accept: "application/json" },
      timeout: 30_000,
    })
    const providers = resp.data.MediaContainer.MediaProvider ?? []
    // Find the first EPG provider (xmltv or gracenote) that has content features
    const epg =
      providers.find(
        (p) =>
          p.identifier.startsWith("tv.plex.providers.epg") &&
          p.Feature?.some((f) => f.type === "content"),
      ) ?? providers.find((p) => p.identifier.startsWith("tv.plex.providers.epg"))

    if (!epg) {
      console.warn("  [epg:plex] No EPG provider found — is Plex Live TV (Plex Pass + tuner) configured?")
      return null
    }
    console.log(`  [epg:plex] Using provider: ${epg.identifier}`)
    return epg.identifier
  }

  async searchByTitle(title: string): Promise<EpgEvent[]> {
    const providerId = await this.getProviderId()
    if (!providerId) return []

    const resp = await axios.get<PlexEpgContainer>(`${this.baseUrl}/${providerId}/grid`, {
      params: {
        ...this.authParams,
        type: 1, // 1 = Movie
        title,
      },
      headers: { Accept: "application/json", Connection: "close" },
      httpAgent: new http.Agent({ keepAlive: false, family: 4 }),
      timeout: 30_000,
    })

    const items = resp.data.MediaContainer.Metadata ?? []
    return items.flatMap((item): EpgEvent[] => {
      const channel = item.Media?.[0]
      if (!channel?.beginsAt) return []
      // Skip entries shorter than 60 minutes — these are TV episodes misclassified
      // as movies by the XMLTV guide (e.g. SpongeBob series episodes show as type=movie)
      const durationMinutes = channel.endsAt ? (channel.endsAt - channel.beginsAt) / 60 : 0
      if (durationMinutes > 0 && durationMinutes < 60) return []
      return [
        {
          eventId: item.ratingKey,
          title: item.title,
          startTime: new Date(channel.beginsAt * 1000),
          endTime: channel.endsAt ? new Date(channel.endsAt * 1000) : new Date(channel.beginsAt * 1000),
          channelId: channel.channelIdentifier ?? channel.channelCallLetters ?? "",
          channelName: channel.channelTitle ?? channel.channelCallLetters ?? "",
          description: item.summary,
          year: item.year,
        },
      ]
    })
  }
}
