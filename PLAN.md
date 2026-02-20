# watchlist2dvr — Finalized Plan

A modular automation service that synchronizes a movie watchlist with a DVR backend. Resolves localized titles, matches them against EPG data, and automatically schedules recordings for upcoming broadcasts.

---

## Core Concept

> You mark a movie "Watch Later" on IMDb. The service picks it up, resolves the correct title for your region, checks your library, and schedules a recording if it shows up in the EPG — fully automatically.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────┐
│           Watchlist Source Adapter           │
│         (Trakt API  |  IMDb CSV export)      │
└──────────────────────┬──────────────────────┘
                       │  WatchlistItem { imdbId, originalTitle, year }
                       ▼
┌─────────────────────────────────────────────┐
│          Library Check Adapter               │
│        (Plex  |  Jellyfin  |  none)          │
│   → skip items already in your library       │
└──────────────────────┬──────────────────────┘
                       │  filtered WatchlistItem[]
                       ▼
┌─────────────────────────────────────────────┐
│         TMDB Localization Resolver           │
│   imdbId → { de: "...", en: "...", fr: "..." }│
│              (cached in Redis)               │
└──────────────────────┬──────────────────────┘
                       │  WatchlistItem with localizedTitles[]
                       ▼
┌─────────────────────────────────────────────┐
│          Title Normalization Pipeline        │
│  lowercase → strip articles → strip editions │
│         → normalize umlauts (optional)       │
└──────────────────────┬──────────────────────┘
                       │  normalized candidates
                       ▼
┌─────────────────────────────────────────────┐
│           EPG Matching Engine                │
│   preferred language → fallbacks → year ±1  │
│          fuzzy only as last resort           │
└──────────────────────┬──────────────────────┘
                       │  EpgEvent[]
                       ▼
┌─────────────────────────────────────────────┐
│         Idempotency Guard                    │
│  check Redis state + DVR existing entries    │
│         → skip if already scheduled         │
└──────────────────────┬──────────────────────┘
                       │  new events only
                       ▼
┌─────────────────────────────────────────────┐
│            DVR Adapter                       │
│             (TVHeadend)                      │
└─────────────────────────────────────────────┘
```

All adapters are pluggable via a defined interface. The core matching engine never knows which source, library, or DVR is in use.

---

## Adapter Interfaces

### Watchlist Source

```ts
interface WatchlistSource {
  fetchWatchlist(): Promise<WatchlistItem[]>
}
```

Implementations:
- **Trakt** — uses Trakt API, passthrough IMDb IDs, OAuth or API key auth
- **IMDb CSV** — parses the CSV export from IMDb's watchlist export feature

### Library Checker

```ts
interface LibraryChecker {
  existsInLibrary(imdbId: string): Promise<boolean>
}
```

Implementations:
- **Jellyfin** — queries `/Items` with IMDb provider ID filter
- **Plex** — queries library sections with IMDb GUID matching
- **None** — always returns `false` (default fallback)

### EPG Provider

```ts
interface EpgProvider {
  searchByTitle(title: string): Promise<EpgEvent[]>
}

interface EpgEvent {
  eventId: string
  title: string
  startTime: Date
  endTime: Date
  channelId: string
  description?: string
  year?: number  // extracted from description if present
}
```

Implementations:
- **TVHeadend** — `/api/epg/events/grid`

### DVR Adapter

```ts
interface DvrAdapter {
  scheduleEvent(eventId: string): Promise<void>
  getScheduledEntries(): Promise<DvrEntry[]>
}
```

Implementations:
- **TVHeadend** — `/api/dvr/entry/create`, `/api/dvr/entry/grid`

---

## Internal Data Model

```ts
interface WatchlistItem {
  imdbId: string
  originalTitle: string
  localizedTitles: Record<string, string>  // { de: "...", en: "..." }
  year?: number
  addedAt: Date
}
```

---

## Title Matching Strategy

Deterministic pipeline first, fuzzy only as explicit fallback.

### Normalization steps (in order):
1. Lowercase
2. Remove leading articles: `the`, `a`, `an`, `der`, `die`, `das`, `ein`, `eine`, `le`, `la`, `les`, `un`, `une`
3. Strip edition markers: `extended cut`, `director's cut`, `remastered`, `theatrical cut`, etc.
4. Remove punctuation except alphanumeric and spaces
5. Collapse whitespace
6. Optionally: normalize umlauts (`ä→ae`, `ö→oe`, `ü→ue`) — configurable

### Matching algorithm:
1. Normalize EPG event title
2. Try exact match on preferred language title
3. Try exact match on each fallback language title
4. If multiple hits → filter by year (±1 tolerance, or skip year constraint if EPG has no year)
5. If still ambiguous → log as ambiguous, skip
6. If fuzzy enabled → apply Fuse.js with configured threshold as final fallback

### Year extraction from EPG:
- Match patterns: `(1995)`, `| 1995 |`, `[1995]`, `USA 1995`
- Configurable: disable year matching if EPG data is unreliable

---

## Configuration Schema

```yaml
# config.yaml

sources:
  - type: trakt
    client_id: ""
    client_secret: ""
    username: ""
    # watchlist_type: movies  # movies | shows | all

  # Alternative (or in addition):
  # - type: imdb_csv
  #   path: /data/watchlist.csv

library:
  - type: jellyfin
    url: http://jellyfin:8096
    api_key: ""
  # - type: plex
  #   url: http://plex:32400
  #   token: ""
  # Omit section entirely to disable library check

tmdb:
  api_key: ""

matching:
  preferred_language: de
  fallback_languages:
    - en
  strict_year_match: false      # false = skip year check if EPG has no year
  year_tolerance: 1             # ±N years
  fuzzy_enabled: false          # opt-in only
  fuzzy_threshold: 0.85         # 0.0–1.0, higher = stricter

dvr:
  type: tvheadend
  url: http://tvheadend:9981
  username: ""
  password: ""

state:
  redis_url: redis://redis:6379

scheduler:
  mode: polling                 # polling | oneshot
  interval_minutes: 60

web:
  port: 3000
  enabled: true
```

---

## State & Idempotency

Two-layer check before any scheduling action:

| Layer | What it checks | How |
|---|---|---|
| **Redis** | Items we've already seen / scheduled in past runs | `SET imdbId:scheduled EX 30d` |
| **DVR** | Items already in TVHeadend's DVR queue | `GET /api/dvr/entry/grid` |

Never create a DVR entry unless both layers confirm it's new.

Redis also caches TMDB translation lookups with a configurable TTL (default 7 days).

---

## Project Structure

```
watchlist2dvr/
├── src/
│   ├── sources/
│   │   ├── index.ts           # WatchlistSource interface
│   │   ├── trakt.ts
│   │   └── imdb-csv.ts
│   ├── library/
│   │   ├── index.ts           # LibraryChecker interface
│   │   ├── jellyfin.ts
│   │   └── plex.ts
│   ├── resolvers/
│   │   └── tmdb.ts            # imdbId → localizedTitles (Redis-cached)
│   ├── matching/
│   │   ├── normalizer.ts      # deterministic normalization pipeline
│   │   └── engine.ts          # matching logic, fuzzy fallback
│   ├── epg/
│   │   ├── index.ts           # EpgProvider interface
│   │   └── tvheadend.ts
│   ├── dvr/
│   │   ├── index.ts           # DvrAdapter interface
│   │   └── tvheadend.ts
│   ├── state/
│   │   └── redis.ts           # state tracking + TMDB cache
│   ├── web/
│   │   ├── server.ts          # Express read-only API
│   │   └── ui/                # minimal frontend (watchlist, schedule, history)
│   ├── scheduler.ts           # main orchestration loop
│   └── config.ts              # config loading + validation (zod)
├── config.yaml.example
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

---

## Web UI (Read-Only)

Minimal embedded web UI served by the service itself — no separate container needed.

### Views:
| View | Content |
|---|---|
| **Watchlist** | All items from source, IMDb ID, titles, year, library status |
| **Upcoming** | Matched EPG events with scheduled recording status |
| **History** | Past run results — matches found, scheduled, skipped, errors |

Manual match correction is out of scope for now — log entries will include enough detail to debug mismatches.

---

## Docker Compose

```yaml
services:
  watchlist2dvr:
    build: .
    restart: unless-stopped
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - ./data:/data             # for IMDb CSV if used
    depends_on:
      - redis
    environment:
      - NODE_ENV=production
    ports:
      - "3000:3000"

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

volumes:
  redis_data:
```

---

## Development Milestones

### M1 — Core pipeline, no scheduling (validate matching quality first)
- [ ] Project scaffold (TypeScript, ESLint, Vitest)
- [ ] Config loading with schema validation (zod)
- [ ] Trakt source adapter
- [ ] TMDB localization resolver with Redis cache
- [ ] Normalization pipeline + unit tests
- [ ] TVHeadend EPG query
- [ ] Matching engine + unit tests
- [ ] Log match candidates, no DVR writes
- [ ] Basic run loop with polling

### M2 — Scheduling
- [ ] TVHeadend DVR adapter (`scheduleEvent`)
- [ ] Redis state tracking (idempotency)
- [ ] DVR entry existence check
- [ ] End-to-end: watchlist item → scheduled recording

### M3 — Library integration
- [ ] Jellyfin library checker adapter
- [ ] Plex library checker adapter
- [ ] Skip items already in library

### M4 — IMDb CSV source
- [ ] Parse IMDb CSV export format
- [ ] Map to internal WatchlistItem model

### M5 — Web UI
- [ ] Express server with REST endpoints
- [ ] Watchlist view
- [ ] Upcoming recordings view
- [ ] Run history view

---

## Key Design Decisions (Final)

| Decision | Choice | Reason |
|---|---|---|
| Watchlist source | Adapter (Trakt + IMDb CSV) | IMDb has no API; Trakt is the clean path but CSV covers offline/manual use |
| Library check | Adapter (Jellyfin, Plex, none) | User runs both; pluggable avoids hardcoding |
| State store | Redis | Caching + state in one container; aligns with existing Compose stacks |
| Localization source | TMDB | Only reliable multilingual title source via IMDb ID |
| Matching strategy | Deterministic first, fuzzy opt-in | Reliability over coverage; fuzzy causes false positives |
| DVR backend | TVHeadend (adapter pattern) | Clean REST API; pluggable for Plex/Jellyfin DVR later |
| Language | TypeScript + Node.js | Type-safe interfaces for adapters; good ecosystem for this stack |
| Web UI | Read-only (M5) | Operational visibility without scope creep |
| Run mode | Polling + oneshot | Polling for always-on; oneshot for external cron |
