import axios from "axios"
import type { DvrAdapter, DvrEntry } from "./index.js"

interface PlexMediaProvider {
  id?: number | string
  identifier: string
  Feature?: Array<{ type: string }>
}

interface PlexProvidersContainer {
  MediaContainer: {
    MediaProvider?: PlexMediaProvider[]
  }
}

interface PlexSubscription {
  key: string
  type: number
  createdAt?: number
  Video?: {
    ratingKey: string
    title?: string
  }
  Directory?: {
    ratingKey: string
    title?: string
  }
}

interface PlexSubscriptionsContainer {
  MediaContainer: {
    MediaSubscription?: PlexSubscription[]
  }
}

/** Fully decode a percent-encoded string (removes all layers of encoding). */
function fullyDecode(s: string): string {
  let prev = ""
  let curr = s
  while (prev !== curr) {
    prev = curr
    try { curr = decodeURIComponent(curr) } catch { break }
  }
  return curr
}

export class PlexDvrAdapter implements DvrAdapter {
  /** Cached promise — provider ID discovery happens once per process lifetime. */
  private providerIdPromise: Promise<number> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    /** Library section ID for DVR Movies (default 6 — auto-detected if possible). */
    private readonly librarySectionId: number = 6,
  ) {}

  private getProviderId(): Promise<number> {
    if (!this.providerIdPromise) this.providerIdPromise = this.fetchProviderId()
    return this.providerIdPromise
  }

  private async fetchProviderId(): Promise<number> {
    const resp = await axios.get<PlexProvidersContainer>(
      `${this.baseUrl}/media/providers`,
      {
        params: { "X-Plex-Token": this.token },
        headers: { Accept: "application/json" },
        timeout: 10_000,
      },
    )
    const providers = resp.data.MediaContainer.MediaProvider ?? []
    const epg =
      providers.find(
        (p) =>
          p.identifier.startsWith("tv.plex.providers.epg") &&
          p.Feature?.some((f) => f.type === "content"),
      ) ?? providers.find((p) => p.identifier.startsWith("tv.plex.providers.epg"))
    if (!epg || epg.id == null) {
      throw new Error("[dvr:plex] Cannot find EPG media provider — is Plex DVR configured?")
    }
    const id = Number(epg.id)
    console.log(`  [dvr:plex] Using media provider id=${id} (${epg.identifier})`)
    return id
  }

  async scheduleEvent(eventId: string): Promise<void> {
    const providerId = await this.getProviderId()
    // Build query params (URLSearchParams encodes bracket chars → %5B%5D, which Plex accepts)
    const qs = new URLSearchParams({
      "X-Plex-Token": this.token,
      type: "1",
      targetLibrarySectionID: String(this.librarySectionId),
      "params[mediaProviderID]": String(providerId),
      "prefs[oneShot]": "true",
    }).toString()
    // Append hints[ratingKey] with literal bracket chars and the raw (pre-encoded) eventId
    // so that the server URL-decodes it exactly once to the canonical single-encoded form.
    const url = `${this.baseUrl}/media/subscriptions?${qs}&hints[ratingKey]=${eventId}`
    console.log(`  [dvr:plex] Subscribing: ${fullyDecode(eventId)}`)
    await axios.post(url, null, {
      headers: { Accept: "application/json" },
      timeout: 10_000,
    })
  }

  async getScheduledEntries(): Promise<DvrEntry[]> {
    const resp = await axios.get<PlexSubscriptionsContainer>(
      `${this.baseUrl}/media/subscriptions`,
      {
        params: { "X-Plex-Token": this.token },
        headers: { Accept: "application/json" },
        timeout: 10_000,
      },
    )
    return (resp.data.MediaContainer.MediaSubscription ?? []).flatMap((s) => {
      const item = s.Video ?? s.Directory
      if (!item?.ratingKey) return []
      return [{
        // Fully-decoded ratingKey used as entryId so the scheduler can compare
        // against EPG eventIds regardless of the encoding layer stored by Plex.
        entryId: fullyDecode(item.ratingKey),
        title: item.title ?? "",
        startTime: new Date((s.createdAt ?? 0) * 1000),
        channelId: "",
        status: "scheduled" as const,
      }]
    })
  }
}
