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
    // The EPG ratingKey comes back URL-encoded from Plex (e.g. "tv%2Eplex%2Exmltv%3A%2F%2F...")
    // Decode it once to get the canonical form Plex expects in the subscription body.
    const ratingKey = decodeURIComponent(eventId)
    console.log(`  [dvr:plex] Subscribing ratingKey: ${ratingKey}`)
    await axios.post(
      `${this.baseUrl}/media/subscriptions`,
      new URLSearchParams({
        type: "1",
        oneShot: "1",
        ratingKey,
      }),
      {
        params: this.authParams,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
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
