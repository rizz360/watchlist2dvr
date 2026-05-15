import axios from "axios"
import http from "http"
import type { DvrAdapter, DvrEntry, DvrScheduleHints } from "./index.js"

const ipv4Agent = new http.Agent({ family: 4 })

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
        httpAgent: ipv4Agent,
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

  async scheduleEvent({ eventId, guid, title, key, airingChannels, airingTimes }: DvrScheduleHints): Promise<void> {
    const providerId = await this.getProviderId()
    // Mirror Plex Web's subscription payload so subscriptions include next airing metadata.
    const qs = new URLSearchParams({
      "X-Plex-Token": this.token,
      type: "1",
      targetLibrarySectionID: String(this.librarySectionId),
      targetSectionLocationID: String(providerId),
      includeGrabs: "1",
      "prefs[minVideoQuality]": "0",
      "prefs[replaceLowerQuality]": "false",
      "prefs[recordPartials]": "false",
      "prefs[startOffsetMinutes]": "0",
      "prefs[endOffsetMinutes]": "5",
      "prefs[lineupChannel]": "",
      "prefs[startTimeslot]": "-1",
      "prefs[comskipEnabled]": "-1",
      "prefs[comskipMethod]": "2",
      "prefs[remoteMedia]": "false",
      "params[mediaProviderID]": String(providerId),
      "params[libraryType]": "1",
      "prefs[oneShot]": "true",
      "hints[type]": "1",
      // hints[ratingKey]: pass the ratingKey as-is (already double-encoded from EPG).
      // URLSearchParams will percent-encode it once more; the HTTP layer decodes once,
      // leaving the double-encoded form that Plex stores and resolves correctly.
      "hints[ratingKey]": eventId,
    })
    // hints[guid]: required for Plex to link the subscription to the correct show entity.
    if (guid) qs.set("hints[guid]", guid)
    // hints[title]: required for Plex to display a non-empty movie title in the DVR queue.
    if (title) qs.set("hints[title]", title)
    // hints[key]: optional full metadata path — extra context for Plex EPG resolution.
    if (key) qs.set("hints[key]", key)
    // params[airingChannels]/params[airingTimes]: direct airing context from EPG.
    if (airingChannels) qs.set("params[airingChannels]", airingChannels)
    if (airingTimes) qs.set("params[airingTimes]", airingTimes)
    const url = `${this.baseUrl}/media/subscriptions?${qs.toString()}`
    await axios.post(url, null, {
      headers: { Accept: "application/json" },
      httpAgent: ipv4Agent,
      timeout: 10_000,
    })
  }

  async getScheduledEntries(): Promise<DvrEntry[]> {
    const resp = await axios.get<PlexSubscriptionsContainer>(
      `${this.baseUrl}/media/subscriptions`,
      {
        params: { "X-Plex-Token": this.token },
        headers: { Accept: "application/json" },
        httpAgent: ipv4Agent,
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
