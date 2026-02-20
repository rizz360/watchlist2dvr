import Redis from "ioredis"
import { loadConfig } from "./config.js"
import { TraktSource } from "./sources/trakt.js"
import { ImdbCsvSource } from "./sources/imdb-csv.js"
import type { WatchlistSource } from "./sources/index.js"
import { JellyfinLibraryChecker } from "./library/jellyfin.js"
import { PlexLibraryChecker } from "./library/plex.js"
import { NoopLibraryChecker } from "./library/index.js"
import type { LibraryChecker } from "./library/index.js"
import { TmdbResolver } from "./resolvers/tmdb.js"
import { TvheadendEpgProvider } from "./epg/tvheadend.js"
import { TvheadendDvrAdapter } from "./dvr/tvheadend.js"
import { MatchingEngine } from "./matching/engine.js"
import { StateStore } from "./state/redis.js"
import type { WatchlistItem } from "./sources/index.js"

const CONFIG_PATH = process.env.CONFIG_PATH ?? "config.yaml"

async function run(): Promise<void> {
  const config = loadConfig(CONFIG_PATH)

  const redis = new Redis(config.state.redis_url)
  const state = new StateStore(redis)
  const tmdb = new TmdbResolver(config.tmdb.api_key, redis)

  // Build watchlist sources
  const sources: WatchlistSource[] = config.sources.map((s) => {
    if (s.type === "trakt") return new TraktSource(s.client_id, s.username)
    return new ImdbCsvSource(s.path)
  })

  // Build library checkers
  const checkers: LibraryChecker[] =
    config.library.length > 0
      ? config.library.map((l) => {
          if (l.type === "jellyfin") return new JellyfinLibraryChecker(l.url, l.api_key)
          return new PlexLibraryChecker(l.url, l.token)
        })
      : [new NoopLibraryChecker()]

  const epg = new TvheadendEpgProvider(config.dvr.url, config.dvr.username, config.dvr.password)
  const dvr = new TvheadendDvrAdapter(config.dvr.url, config.dvr.username, config.dvr.password)

  const engine = new MatchingEngine({
    preferredLanguage: config.matching.preferred_language,
    fallbackLanguages: config.matching.fallback_languages,
    strictYearMatch: config.matching.strict_year_match,
    yearTolerance: config.matching.year_tolerance,
    fuzzyEnabled: config.matching.fuzzy_enabled,
    fuzzyThreshold: config.matching.fuzzy_threshold,
  })

  console.log(`[watchlist2dvr] Starting run at ${new Date().toISOString()}`)

  // 1. Fetch watchlist from all sources (deduplicate by imdbId)
  const allItems = new Map<string, WatchlistItem>()
  for (const source of sources) {
    const items = await source.fetchWatchlist()
    console.log(`  [source] Fetched ${items.length} items`)
    for (const item of items) {
      if (!allItems.has(item.imdbId)) allItems.set(item.imdbId, item)
    }
  }
  console.log(`  [source] Total unique items: ${allItems.size}`)

  // 2. Filter items already in library
  let remaining = [...allItems.values()]
  for (const checker of checkers) {
    const filtered = await Promise.all(
      remaining.map(async (item) => ({
        item,
        inLibrary: await checker.existsInLibrary(item.imdbId),
      })),
    )
    const inLibraryCount = filtered.filter((r) => r.inLibrary).length
    if (inLibraryCount > 0) {
      console.log(`  [library] Skipping ${inLibraryCount} item(s) already in library`)
    }
    remaining = filtered.filter((r) => !r.inLibrary).map((r) => r.item)
  }

  // 3. Filter items already scheduled in Redis state
  const stateFiltered = await Promise.all(
    remaining.map(async (item) => ({ item, scheduled: await state.isScheduled(item.imdbId) })),
  )
  const alreadyScheduled = stateFiltered.filter((r) => r.scheduled).length
  if (alreadyScheduled > 0) {
    console.log(`  [state] Skipping ${alreadyScheduled} item(s) already scheduled`)
  }
  remaining = stateFiltered.filter((r) => !r.scheduled).map((r) => r.item)

  if (remaining.length === 0) {
    console.log("  [run] Nothing to process.")
    await redis.quit()
    return
  }

  // 4. Resolve TMDB localized titles
  console.log(`  [tmdb] Resolving titles for ${remaining.length} item(s)...`)
  for (const item of remaining) {
    const titles = await tmdb.resolveLocalizedTitles(item.imdbId)
    item.localizedTitles = titles
  }

  // 5. Query EPG for each candidate title (preferred + fallback languages)
  const titlesToQuery = new Set<string>()
  const langs = [config.matching.preferred_language, ...config.matching.fallback_languages]
  for (const item of remaining) {
    for (const lang of langs) {
      const t = item.localizedTitles[lang]
      if (t) titlesToQuery.add(t)
    }
    titlesToQuery.add(item.originalTitle)
  }

  console.log(`  [epg] Querying ${titlesToQuery.size} title(s) against EPG...`)
  const epgResults: Awaited<ReturnType<typeof epg.searchByTitle>> = []
  const seenEventIds = new Set<string>()
  for (const title of titlesToQuery) {
    try {
      const events = await epg.searchByTitle(title)
      for (const e of events) {
        if (!seenEventIds.has(e.eventId)) {
          seenEventIds.add(e.eventId)
          epgResults.push(e)
        }
      }
    } catch (err) {
      console.warn(`  [epg] Failed to query "${title}":`, (err as Error).message)
    }
  }
  console.log(`  [epg] Found ${epgResults.length} EPG event(s)`)

  // 6. Run matching engine
  const { matches, ambiguous, unmatched } = engine.match(remaining, epgResults)

  console.log(`\n  [match] Results:`)
  console.log(`    Matched:   ${matches.length}`)
  console.log(`    Ambiguous: ${ambiguous.length}`)
  console.log(`    Unmatched: ${unmatched.length}`)

  for (const m of matches) {
    console.log(
      `    ✓ "${m.item.originalTitle}" → "${m.event.title}" on ${m.event.channelName}` +
        ` @ ${m.event.startTime.toISOString()} [${m.confidence}, lang=${m.matchedLanguage}]`,
    )
  }

  for (const a of ambiguous) {
    console.log(`    ? "${a.item.originalTitle}" — ambiguous: ${a.reason}`)
  }

  for (const u of unmatched) {
    console.log(`    ✗ "${u.originalTitle}" (${u.imdbId}) — no EPG match found`)
  }

  // 7. Check DVR for already-scheduled entries, then schedule new ones
  let dvrEntries: Awaited<ReturnType<typeof dvr.getScheduledEntries>> = []
  try {
    dvrEntries = await dvr.getScheduledEntries()
  } catch (err) {
    console.warn("  [dvr] Could not fetch existing DVR entries:", (err as Error).message)
  }

  const scheduledEventIds = new Set(dvrEntries.map((e) => e.entryId))

  let scheduled = 0
  for (const m of matches) {
    if (scheduledEventIds.has(m.event.eventId)) {
      console.log(`  [dvr] Already in DVR queue: "${m.item.originalTitle}"`)
      await state.markScheduled(m.item.imdbId)
      continue
    }

    try {
      await dvr.scheduleEvent(m.event.eventId)
      await state.markScheduled(m.item.imdbId)
      console.log(`  [dvr] Scheduled: "${m.item.originalTitle}"`)
      scheduled++
    } catch (err) {
      console.error(`  [dvr] Failed to schedule "${m.item.originalTitle}":`, (err as Error).message)
    }
  }

  console.log(`\n[watchlist2dvr] Done. Scheduled ${scheduled} new recording(s).`)

  await redis.quit()
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.CONFIG_PATH ?? "config.yaml")

  if (config.scheduler.mode === "oneshot") {
    await run()
    return
  }

  // Polling mode
  const intervalMs = config.scheduler.interval_minutes * 60 * 1000
  console.log(`[watchlist2dvr] Polling mode: running every ${config.scheduler.interval_minutes} minute(s)`)

  while (true) {
    try {
      await run()
    } catch (err) {
      console.error("[watchlist2dvr] Run failed:", (err as Error).message)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

main().catch((err) => {
  console.error("[watchlist2dvr] Fatal error:", err)
  process.exit(1)
})
