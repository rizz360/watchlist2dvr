# watchlist2dvr

Automatically records movies from your IMDb watchlist on your DVR — fully hands-off.

You mark a film "Watch Later" on IMDb. watchlist2dvr picks it up, resolves the correct localized title for your region, checks whether you already own it, and schedules a recording the next time it appears in the EPG.

---

## How it works

```
IMDb watchlist CSV + ratings CSV (or Trakt)
      ↓
Plex / Jellyfin library check  →  skip if already owned (bulk fetch, Set lookup)
      ↓
TMDB localization resolver     →  "Die Hard" → "Stirb langsam"
      ↓
Title normalization pipeline   →  strip articles, editions, punctuation, year suffixes
      ↓
TVHeadend EPG search           →  find upcoming broadcasts
      ↓
Matching engine                →  preferred language → fallbacks → year filter → earliest airing
      ↓
Idempotency check              →  Redis state + DVR queue
      ↓
TVHeadend DVR                  →  schedule recording
```

Every layer is a swappable adapter. The matching engine never knows which source, library, or DVR is in use.

---

## Features

- **IMDb watchlist + ratings** — point `path` at a directory; all CSVs are loaded automatically. Ratings CSVs filter by `min_rating`. Only Movies and TV Movies are processed (video games, shorts, and series are skipped).
- **Localized title matching** — resolves titles in your preferred language via TMDB (e.g. German, French, …)
- **Library check** — skips movies already in Plex or Jellyfin. The entire library is fetched once and indexed as an in-memory Set — no per-item HTTP requests.
- **Deterministic matching** — lowercase → strip articles → strip editions → strip year suffixes → year filter. Fuzzy matching is opt-in fallback only. Multiple airings of the same movie resolve to the earliest broadcast.
- **Idempotency** — never schedules the same movie twice (Redis state + live DVR queue check)
- **Dry-run mode** — validate match quality before writing anything to TVHeadend
- **Aggressive caching** — TMDB lookups cached 7 days, library index 6 hours; EPG is always live
- **Read-only web dashboard** — full watchlist status with search/filter, upcoming recordings, run history, TMDB cache debug
- **Docker-first** — ships as a single container alongside Redis; Tailscale MagicDNS supported via `dns: [100.100.100.100]`

---

## Quick start

### 1. Export your IMDb data

- **Watchlist**: [imdb.com/list/watchlist](https://www.imdb.com/list/watchlist) → Export
- **Ratings** (optional): [imdb.com/user/ur.../ratings](https://www.imdb.com/user/) → Export

Drop both CSV files into the `data/` directory. The source auto-detects which is which by inspecting the headers. Ratings entries below `min_rating` are ignored.

### 2. Configure

```sh
cp config.yaml.example config.yaml
```

Edit `config.yaml` — at minimum fill in:

| Key | Where to get it |
|---|---|
| `tmdb.api_key` | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — free account |
| `library[].token` (Plex) | Plex Web → Account → Authorized Devices → token in URL |
| `library[].api_key` (Jellyfin) | Jellyfin Dashboard → API Keys |
| `dvr.url` | Your TVHeadend base URL, e.g. `http://192.168.1.10:9981` |

### 3. First run (dry-run)

```sh
docker compose up --build
```

`dry_run: true` is the default. Nothing is written to TVHeadend. Check the logs and open the dashboard at **http://localhost:3000** to verify match quality.

### 4. Enable scheduling

Once the matches look correct, flip the flag in `config.yaml`:

```yaml
scheduler:
  dry_run: false
  mode: polling          # runs every interval_minutes
  interval_minutes: 60
```

Restart: `docker compose up -d`

---

## Configuration reference

```yaml
# --- Watchlist sources (at least one required) ---
sources:
  - type: imdb_csv
    path: /data             # directory — all .csv files are loaded automatically
    min_rating: 5           # for ratings CSVs: only include movies rated ≥ this

  # - type: trakt
  #   client_id: ""
  #   client_secret: ""
  #   username: ""

# --- Library checkers (optional, any combination) ---
library:
  - type: plex
    url: http://plex:32400
    token: ""

  # - type: jellyfin
  #   url: http://jellyfin:8096
  #   api_key: ""

# --- TMDB (required for localization) ---
tmdb:
  api_key: ""

# --- Matching ---
matching:
  preferred_language: de        # ISO 639-1 code
  fallback_languages:
    - en
  strict_year_match: false      # false = skip year check if EPG has no year data
  year_tolerance: 1             # ±N years allowed when EPG has a year
  fuzzy_enabled: false          # opt-in fuzzy fallback (Fuse.js)
  fuzzy_threshold: 0.85         # 0–1, higher = stricter

# --- DVR backend ---
dvr:
  type: tvheadend
  url: http://tvheadend:9981
  username: ""                  # leave empty for anonymous access
  password: ""

# --- State / cache ---
state:
  redis_url: redis://redis:6379

# --- Scheduler ---
scheduler:
  mode: polling                 # polling | oneshot
  interval_minutes: 60
  dry_run: true                 # true = log matches, never write to DVR

# --- Web UI ---
web:
  enabled: true
  port: 3000
```

---

## Title matching

Most DIY projects fail here. watchlist2dvr uses a deterministic pipeline — no guessing.

### Normalization steps (in order)

1. Strip trailing year suffixes — `Foo (2025)` → `Foo`
2. Strip edition markers — `Extended Edition`, `Director's Cut`, `Remastered`, …
3. Lowercase
4. Normalize umlauts — `ä → ae`, `ö → oe`, `ü → ue`
5. Strip leading articles — `the`, `a`, `an`, `der`, `die`, `das`, `le`, `la`, …
6. Strip diacritical marks — `é → e`, `ñ → n`, …
7. Remove punctuation
8. Collapse whitespace

### Matching algorithm

1. Pre-normalize all EPG events once (year suffixes stripped before comparison, but year is extracted separately for filtering)
2. Try exact match on `preferred_language` title
3. Try exact match on each `fallback_languages` title in order
4. Filter candidates by year (±`year_tolerance`, skipped if EPG has no year and `strict_year_match: false`)
5. If multiple airings remain → pick the earliest broadcast
6. If `fuzzy_enabled: true` → Fuse.js as last resort

### Why TMDB?

IMDb has no public API for structured multilingual titles. TMDB does:

```
IMDb ID  →  TMDB /find/{id}  →  TMDB /movie/{id}/translations
         →  { de: "Stirb langsam", en: "Die Hard", fr: "Piège de cristal", … }
```

Both lookups are Redis-cached for 7 days and fetched 10 at a time.

---

## Web dashboard

Available at `http://localhost:3000` (or your configured port).

| Tab | Content |
|---|---|
| **Watchlist** | All 592+ items from the last run — matched, scheduled, in-library, and unmatched, with IMDb links, user ratings, and source badges. Filterable by status and searchable by title. |
| **Upcoming** | Live DVR queue from TVHeadend, filtered to scheduled/recording, sorted by airtime |
| **History** | Last 50 runs — item counts, scheduled count, errors, dry-run indicator |
| **Debug** | TMDB cache size by key prefix, live IMDb ID lookup |

---

## Caching

| Data | Backend | TTL |
|---|---|---|
| TMDB IMDb → ID | Redis | 7 days |
| TMDB localized titles | Redis | 7 days |
| Plex library index | Redis | 6 hours |
| Jellyfin library index | Redis | 6 hours |
| Scheduled-item state | Redis | 30 days |
| TVHeadend EPG | — | not cached (always live) |

To clear all caches: `docker compose exec redis redis-cli FLUSHDB`  
To force a Plex re-index: `docker compose exec redis redis-cli del plex:library:all`

---

## Docker Compose

The default `docker-compose.yml` runs two services:

| Service | Image |
|---|---|
| `watchlist2dvr` | Built from local `Dockerfile` |
| `redis` | `redis:7-alpine` with AOF persistence |

Mount your IMDb CSVs and config:

```yaml
volumes:
  - ./config.yaml:/app/config.yaml:ro
  - ./data:/data          # place watchlist.csv and/or ratings.csv here
```

`config.yaml` is gitignored — never committed.

If TVHeadend or Plex are accessed via **Tailscale MagicDNS**, add the Tailscale DNS resolver to the compose service:

```yaml
dns:
  - 100.100.100.100
```

---

## Project structure

```
src/
├── sources/          # WatchlistSource interface + Trakt, IMDb CSV adapters
├── library/          # LibraryChecker interface + Plex, Jellyfin adapters
├── resolvers/        # TMDB localization resolver (Redis-cached)
├── matching/
│   ├── normalizer.ts # Deterministic title normalization pipeline
│   └── engine.ts     # Matching logic + fuzzy fallback
├── epg/              # EpgProvider interface + TVHeadend adapter
├── dvr/              # DvrAdapter interface + TVHeadend adapter
├── state/
│   ├── redis.ts      # Idempotency state store
│   └── history.ts    # Run history (persisted in Redis)
├── web/
│   └── server.ts     # Express read-only dashboard
├── config.ts         # Config schema (zod) + loader
└── scheduler.ts      # Main orchestration loop
```

---

## Development

```sh
npm install
npm run dev          # run with tsx watch (requires local Redis)
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

Tests cover the normalization pipeline and matching engine. All 20 tests run in under 400ms with no network calls.

---

## Roadmap

- [ ] Trakt OAuth flow (currently public watchlist / API key only)
- [ ] Manual match override via web UI
- [ ] Notification on successful schedule (webhook / Apprise)
- [ ] Series / episode support
- [ ] Additional DVR backends (Plex DVR, Jellyfin)
