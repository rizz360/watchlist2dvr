import Redis from "ioredis"
import { loadConfig, type Config } from "./config.js"
import { TraktSource } from "./sources/trakt.js"
import { ImdbCsvSource } from "./sources/imdb-csv.js"
import type { WatchlistSource, WatchlistItem } from "./sources/index.js"
import { JellyfinLibraryChecker } from "./library/jellyfin.js"
import { PlexLibraryChecker } from "./library/plex.js"
import { NoopLibraryChecker, type LibraryChecker } from "./library/index.js"
import { TmdbResolver } from "./resolvers/tmdb.js"
import { TvheadendEpgProvider } from "./epg/tvheadend.js"
import { PlexEpgProvider } from "./epg/plex.js"
import type { EpgProvider } from "./epg/index.js"
import { TvheadendDvrAdapter } from "./dvr/tvheadend.js"
import { PlexDvrAdapter } from "./dvr/plex.js"
import type { DvrAdapter } from "./dvr/index.js"
import { MatchingEngine } from "./matching/engine.js"
import { StateStore } from "./state/redis.js"
import { HistoryStore, type RunRecord } from "./state/history.js"
import { startWebServer } from "./web/server.js"

interface RunDeps {
  config: Config
  state: StateStore
  history: HistoryStore
  tmdb: TmdbResolver
  sources: WatchlistSource[]
  checkers: LibraryChecker[]
  epg: EpgProvider
  dvr: DvrAdapter
  engine: MatchingEngine
}

function buildDeps(config: Config, redis: Redis): RunDeps {
  return {
    config,
    state: new StateStore(redis),
    history: new HistoryStore(redis),
    tmdb: new TmdbResolver(config.tmdb.api_key, redis),
    sources: config.sources.map((s) => {
      if (s.type === "trakt") return new TraktSource(s.client_id, s.username)
      return new ImdbCsvSource(s.path, s.min_rating)
    }),
    checkers:
      config.library.length > 0
        ? config.library.map((l) => {
            if (l.type === "jellyfin") return new JellyfinLibraryChecker(l.url, l.api_key, redis)
            return new PlexLibraryChecker(l.url, l.token, redis)
          })
        : [new NoopLibraryChecker()],
    epg:
      config.dvr.type === "plex"
        ? new PlexEpgProvider(config.dvr.url, config.dvr.token)
        : new TvheadendEpgProvider(config.dvr.url, config.dvr.username, config.dvr.password),
    dvr:
      config.dvr.type === "plex"
        ? new PlexDvrAdapter(config.dvr.url, config.dvr.token)
        : new TvheadendDvrAdapter(config.dvr.url, config.dvr.username, config.dvr.password),
    engine: new MatchingEngine({
      preferredLanguage: config.matching.preferred_language,
      fallbackLanguages: config.matching.fallback_languages,
      strictYearMatch: config.matching.strict_year_match,
      yearTolerance: config.matching.year_tolerance,
      fuzzyEnabled: config.matching.fuzzy_enabled,
      fuzzyThreshold: config.matching.fuzzy_threshold,
    }),
  }
}

async function run(deps: RunDeps): Promise<void> {
  const { config, state, history, tmdb, sources, checkers, epg, dvr, engine } = deps
  const startedAt = new Date().toISOString()
  const errors: string[] = []

  console.log(`[watchlist2dvr] Starting run at ${startedAt}`)

  // 1. Fetch watchlist from all sources (deduplicate by imdbId)
  const allItems = new Map<string, WatchlistItem>()
  for (const source of sources) {
    try {
      const items = await source.fetchWatchlist()
      console.log(`  [source] Fetched ${items.length} items`)
      for (const item of items) {
        if (!allItems.has(item.imdbId)) allItems.set(item.imdbId, item)
      }
    } catch (err) {
      const msg = `Source fetch failed: ${(err as Error).message}`
      errors.push(msg)
      console.error(`  [source] ${msg}`)
    }
  }
  console.log(`  [source] Total unique items: ${allItems.size}`)
  const itemsTotal = allItems.size

  // 2. Filter: already in library
  let remaining = [...allItems.values()]
  let itemsInLibrary = 0
  const inLibraryItems: Array<{ imdbId: string; originalTitle: string; source: "watchlist" | "rating"; userRating?: number }> = []
  for (const checker of checkers) {
    console.log(`  [library] Checking ${remaining.length} item(s) against library...`)
    const results = await Promise.all(
      remaining.map(async (item) => ({
        item,
        inLibrary: await checker.existsInLibrary(item.imdbId).catch(() => false),
      })),
    )
    const libItems = results.filter((r) => r.inLibrary)
    if (libItems.length > 0) {
      console.log(`  [library] Skipping ${libItems.length} item(s) already in library`)
      itemsInLibrary += libItems.length
      inLibraryItems.push(...libItems.map((r) => ({
        imdbId: r.item.imdbId,
        originalTitle: r.item.originalTitle,
        source: r.item.source,
        userRating: r.item.userRating,
      })))
    }
    remaining = results.filter((r) => !r.inLibrary).map((r) => r.item)
  }

  // 3. Filter: already scheduled in state (batched, 20 concurrent)
  console.log(`  [state] Checking ${remaining.length} item(s) against scheduled state...`)
  const STATE_CONCURRENCY = 20
  const stateResultsAll: Array<{ item: typeof remaining[0]; scheduled: boolean }> = []
  for (let i = 0; i < remaining.length; i += STATE_CONCURRENCY) {
    const batch = remaining.slice(i, i + STATE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (item) => ({ item, scheduled: await state.isScheduled(item.imdbId) })),
    )
    stateResultsAll.push(...results)
  }
  const stateFiltered = stateResultsAll
  const itemsAlreadyScheduled = stateFiltered.filter((r) => r.scheduled).length
  const alreadyScheduledItems = stateFiltered
    .filter((r) => r.scheduled)
    .map((r) => ({
      imdbId: r.item.imdbId,
      originalTitle: r.item.originalTitle,
      source: r.item.source,
      userRating: r.item.userRating,
    }))
  if (itemsAlreadyScheduled > 0) {
    console.log(`  [state] Skipping ${itemsAlreadyScheduled} item(s) already scheduled`)
  }
  remaining = stateFiltered.filter((r) => !r.scheduled).map((r) => r.item)

  if (remaining.length === 0) {
    console.log("  [run] Nothing new to process.")
    await history.saveRun({
      id: startedAt,
      startedAt,
      completedAt: new Date().toISOString(),
      dryRun: config.scheduler.dry_run,
      itemsTotal,
      itemsInLibrary,
      itemsAlreadyScheduled,
      matchesFound: 0,
      scheduled: 0,
      ambiguous: 0,
      unmatched: 0,
      errors,
      matches: [],
      ambiguousItems: [],
      unmatchedItems: [],
      inLibraryItems,
      alreadyScheduledItems,
    })
    return
  }

  // 4. Resolve TMDB localized titles (batched parallel, 10 at a time)
  console.log(`  [tmdb] Resolving titles for ${remaining.length} item(s)...`)
  const TMDB_CONCURRENCY = 10
  let tmdbDone = 0
  for (let i = 0; i < remaining.length; i += TMDB_CONCURRENCY) {
    const batch = remaining.slice(i, i + TMDB_CONCURRENCY)
    await Promise.all(
      batch.map(async (item) => {
        try {
          item.localizedTitles = await tmdb.resolveLocalizedTitles(item.imdbId)
        } catch (err) {
          errors.push(`TMDB lookup failed for ${item.imdbId}: ${(err as Error).message}`)
        }
        tmdbDone++
      }),
    )
    if (tmdbDone % 50 === 0 || tmdbDone === remaining.length) {
      console.log(`  [tmdb] ${tmdbDone}/${remaining.length} resolved...`)
    }
  }

  // 5. Query EPG
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

  // 6. Match
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
    console.log(`    ? "${a.item.originalTitle}" — ${a.reason}`)
  }
  for (const u of unmatched) {
    console.log(`    ✗ "${u.originalTitle}" (${u.imdbId})`)
  }

  // 7. Schedule new recordings
  const dryRun = config.scheduler.dry_run
  let dvrEntries: Awaited<ReturnType<typeof dvr.getScheduledEntries>> = []
  if (!dryRun) {
    try {
      dvrEntries = await dvr.getScheduledEntries()
    } catch (err) {
      const msg = `Could not fetch DVR entries: ${(err as Error).message}`
      errors.push(msg)
      console.warn(`  [dvr] ${msg}`)
    }
  }

  const scheduledEventIds = new Set(dvrEntries.map((e) => e.entryId))
  let scheduled = 0

  for (const m of matches) {
    if (dryRun) {
      console.log(`  [dvr] DRY RUN — would schedule: "${m.item.originalTitle}"`)
      continue
    }
    if (scheduledEventIds.has(m.event.eventId)) {
      console.log(`  [dvr] Already in DVR queue: "${m.item.originalTitle}"`)
      await state.markScheduled(m.item.imdbId)
      continue
    }
    try {
      console.log(`  [dvr] Scheduling: "${m.item.originalTitle}" (eventId=${m.event.eventId}, epgTitle="${m.event.title}")`)
      await dvr.scheduleEvent(m.event.eventId)
      await state.markScheduled(m.item.imdbId)
      console.log(`  [dvr] Scheduled: "${m.item.originalTitle}"`)
      scheduled++
    } catch (err) {
      const axiosBody =
        (err as { response?: { data?: unknown } }).response?.data
      const detail = axiosBody ? ` — ${JSON.stringify(axiosBody)}` : ""
      const msg = `Failed to schedule "${m.item.originalTitle}": ${(err as Error).message}${detail}`
      errors.push(msg)
      console.error(`  [dvr] ${msg}`)
    }
  }

  const completedAt = new Date().toISOString()
  console.log(`\n[watchlist2dvr] Done.${dryRun ? " (DRY RUN)" : ""} Scheduled ${scheduled} new recording(s).`)

  // 8. Persist run record for history / web UI
  const record: RunRecord = {
    id: startedAt,
    startedAt,
    completedAt,
    dryRun,
    itemsTotal,
    itemsInLibrary,
    itemsAlreadyScheduled,
    matchesFound: matches.length,
    scheduled,
    ambiguous: ambiguous.length,
    unmatched: unmatched.length,
    errors,
    matches: matches.map((m) => ({
      imdbId: m.item.imdbId,
      originalTitle: m.item.originalTitle,
      localizedTitle: m.item.localizedTitles[config.matching.preferred_language],
      source: m.item.source,
      userRating: m.item.userRating,
      epgTitle: m.event.title,
      channelName: m.event.channelName,
      startTime: m.event.startTime.toISOString(),
      confidence: m.confidence,
      matchedLanguage: m.matchedLanguage,
    })),
    ambiguousItems: ambiguous.map((a) => ({
      imdbId: a.item.imdbId,
      originalTitle: a.item.originalTitle,
      localizedTitle: a.item.localizedTitles[config.matching.preferred_language],
      source: a.item.source,
      userRating: a.item.userRating,
      reason: a.reason,
    })),
    unmatchedItems: unmatched.map((u) => ({
      imdbId: u.imdbId,
      originalTitle: u.originalTitle,
      localizedTitle: u.localizedTitles[config.matching.preferred_language],
      source: u.source,
      userRating: u.userRating,
      year: u.year,
    })),
    inLibraryItems,
    alreadyScheduledItems,
  }
  await history.saveRun(record)
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.CONFIG_PATH ?? "config.yaml")

  const redis = new Redis(config.state.redis_url)
  redis.on("error", (err: Error) => console.error("[redis]", err.message))

  const deps = buildDeps(config, redis)

  if (config.web.enabled) {
    startWebServer({ dvr: deps.dvr, history: deps.history, redis }, config.web.port)
  }

  const shutdown = async () => {
    console.log("\n[watchlist2dvr] Shutting down...")
    await redis.quit()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown())
  process.on("SIGINT", () => void shutdown())

  if (config.scheduler.mode === "oneshot") {
    await run(deps)
    if (!config.web.enabled) {
      // No web server keeping the process alive — exit cleanly
      await redis.quit()
    }
    // If web is enabled the HTTP server holds the event loop; Redis stays
    // connected so the dashboard can serve the completed run data.
    return
  }

  const intervalMs = config.scheduler.interval_minutes * 60 * 1000
  console.log(
    `[watchlist2dvr] Polling every ${config.scheduler.interval_minutes} minute(s). Web UI on :${config.web.port}`,
  )

  while (true) {
    try {
      await run(deps)
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

