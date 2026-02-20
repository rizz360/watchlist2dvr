import axios from "axios"
import type { DvrAdapter, DvrEntry } from "./index.js"

interface PlexSubscription {
  ratingKey: string
  title: string
  beginsAt?: number // epoch seconds
  endsAt?: number // epoch seconds
  Media?: Array<{
    channelIdentifier?: string
    channelCallLetters?: string
    channelTitle?: string
  }>
}

interface PlexSubscriptionsContainer {
  MediaContainer: {
    MediaSubscription?: PlexSubscription[]
  }
}

export class PlexDvrAdapter implements DvrAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private get authParams() {
    return { "X-Plex-Token": this.token }
  }

  async scheduleEvent(eventId: string): Promise<void> {
    // The EPG ratingKey is double-URL-encoded from Plex — decode fully
    let ratingKey = eventId
    let prev = ""
    while (prev !== ratingKey) {
      prev = ratingKey
      try { ratingKey = decodeURIComponent(ratingKey) } catch { break }
    }
    console.log(`  [dvr:plex] Subscribing ratingKey: ${ratingKey}`)
    await axios.post(
      `${this.baseUrl}/media/subscriptions`,
      null,
      {
        params: {
          ...this.authParams,
          type: "1",
          oneShot: "1",
          ratingKey,
        },
        headers: { Accept: "application/json" },
        timeout: 10_000,
      },
    )
  }

  async getScheduledEntries(): Promise<DvrEntry[]> {
    const resp = await axios.get<PlexSubscriptionsContainer>(
      `${this.baseUrl}/media/subscriptions`,
      {
        params: this.authParams,
        headers: { Accept: "application/json" },
        timeout: 10_000,
      },
    )
    return (resp.data.MediaContainer.MediaSubscription ?? [])
      .filter((s) => !!s.beginsAt)
      .map((s) => ({
        entryId: s.ratingKey,
        title: s.title,
        startTime: new Date((s.beginsAt ?? 0) * 1000),
        endTime: s.endsAt ? new Date(s.endsAt * 1000) : undefined,
        channelId: s.Media?.[0]?.channelIdentifier ?? s.Media?.[0]?.channelCallLetters ?? "",
        channelName: s.Media?.[0]?.channelTitle,
        status: "scheduled" as const,
      }))
  }
}
