# watchlist2dvr

[![Build](https://github.com/rizz360/watchlist2dvr/actions/workflows/docker-publish.yml/badge.svg?branch=main)](https://github.com/rizz360/watchlist2dvr/actions/workflows/docker-publish.yml)
[![Release](https://img.shields.io/github/v/release/rizz360/watchlist2dvr?label=release&logo=github)](https://github.com/rizz360/watchlist2dvr/releases)
[![Docker Image](https://img.shields.io/docker/v/irizzu/watchlist2dvr?label=docker&logo=docker&logoColor=white)](https://hub.docker.com/r/irizzu/watchlist2dvr)
[![Docker Pulls](https://img.shields.io/docker/pulls/irizzu/watchlist2dvr?logo=docker&logoColor=white)](https://hub.docker.com/r/irizzu/watchlist2dvr)
[![Node](https://img.shields.io/badge/node-22-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

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
EPG search (TVHeadend or Plex) →  find upcoming broadcasts
      ↓
Matching engine                →  preferred language → fallbacks → year filter → earliest airing
      ↓
Idempotency check              →  Redis state + DVR queue
      ↓
DVR (TVHeadend or Plex)        →  schedule recording
```

Every layer is a swappable adapter. The matching engine never knows which source, library, or DVR is in use.

---

## Features

- **IMDb public lists (no auth)** — the `imdb_public_lists` source fetches any public IMDb URL (Top 250, MovieMeter, Popular, public user lists) by parsing the embedded Next.js page data. No cookie or account required. Just point it at one or more URLs.
- **IMDb watchlist + ratings (auto-download)** — the `imdb_auto` source fetches your watchlist and ratings CSV directly from IMDb using a session cookie. No browser automation, no Python, no file management — just paste your `at-main` cookie. See [IMDb auto-download](#imdb-auto-download) below.
- **IMDb watchlist + ratings (manual CSV)** — point `path` at a directory; all CSVs are loaded automatically. Ratings CSVs filter by `min_rating`. Only Movies and TV Movies are processed (video games, shorts, and series are skipped).
- **TMDB lists** — the `tmdb_lists` source pulls movies from TMDB collections (`collection:<id>`), custom TMDB lists (`list:<id>`), and named endpoints (`popular`, `top_rated`, `now_playing`, `upcoming`). No IMDb account required — uses your existing TMDB API key.
- **Localized title matching** — resolves titles in your preferred language via TMDB (e.g. German, French, …)
- **Library check** — skips movies already in Plex or Jellyfin. The entire library is fetched once and indexed as an in-memory Set — no per-item HTTP requests.
- **Deterministic matching** — lowercase → strip articles → strip editions → strip year suffixes → year filter. Fuzzy matching is opt-in fallback only. Multiple airings of the same movie resolve to the earliest broadcast.
- **Idempotency** — never schedules the same movie twice (Redis distributed lock + state check + live DVR queue check)
- **Dry-run mode** — validate match quality before writing anything to the DVR
- **Aggressive caching** — TMDB lookups cached 7 days, library index 6 hours; EPG is always live
- **Notifications** — push alerts via [ntfy](https://ntfy.sh) when a recording is scheduled; supports public topics and authenticated private servers
- **TMDB watchlist sync** — optionally mirrors all collected IMDb IDs to your TMDB watchlist each run (requires a TMDB session ID)
- **Read-only web dashboard** — full watchlist status with search/filter, upcoming recordings, run history, TMDB cache debug, cache clear buttons
- **Docker-first** — ships as a single container alongside Redis; Tailscale MagicDNS supported via `dns: [100.100.100.100]`

---

## Quick start

### 1. Clone and prepare

```sh
git clone https://github.com/rizz360/watchlist2dvr.git
cd watchlist2dvr
mkdir -p data
```

### 2. Get your IMDb data into the service

You have two options:

**Option A — Auto-download (recommended for personal watchlist + ratings)**

The `imdb_auto` source fetches your watchlist and ratings directly. You only need one value from your browser:

1. Go to [imdb.com](https://www.imdb.com) and sign in
2. Open DevTools: `F12` on Windows/Linux · `Cmd+Option+I` on Mac
3. **Application** tab → **Storage** → **Cookies** → `https://www.imdb.com`
4. Find the row where **Name** = `at-main` → copy its **Value**
5. Your user ID is the `urXXXXXXX` part of your IMDb profile URL

```yaml
sources:
  - type: imdb_auto
    user_id: "ur12345678"
    cookie: "YOUR_AT_MAIN_COOKIE_VALUE"
    lists:
      - watchlist
      - ratings
    min_rating: 1
```

The cookie expires when you log out of IMDb. The **Sources** tab in the web dashboard shows the last fetch status and has a **Refresh** button to re-check without restarting the service. When the cookie expires, re-copy `at-main` from DevTools and update `config.yaml`.

**Option B — Public lists (no account required)**

The `imdb_public_lists` source works with any public IMDb URL — no cookies, no account:

```yaml
sources:
  - type: imdb_public_lists
    lists:
      - https://www.imdb.com/chart/top/        # IMDb Top 250
      - https://www.imdb.com/chart/popular/
      - https://www.imdb.com/list/ls000024621/ # any public user list
```

**Option D — TMDB collections and lists**

The `tmdb_lists` source pulls movies from TMDB without any IMDb account. Supports franchise collections, custom TMDB lists, and named popularity endpoints:

```yaml
sources:
  - type: tmdb_lists
    lists:
      - "collection:9485"   # Fast & Furious (TMDB franchise collection)
      - "collection:645"    # James Bond
      - "list:12179"        # any public TMDB custom list
      - "top_rated"         # named: popular | top_rated | now_playing | upcoming
    pages: 5                # pages to fetch for named endpoints
```

The TMDB API key from your `tmdb` config block is reused — no separate credentials needed.

**Option E — Manual CSV export**

- **Watchlist**: [imdb.com/list/watchlist](https://www.imdb.com/list/watchlist) → Export
- **Ratings** (optional): [imdb.com/user/ur.../ratings](https://www.imdb.com/user/) → Export

Drop both CSV files into the `data/` directory. The source auto-detects which is which by inspecting the headers.

### 3. Configure

```sh
cp config.yaml.example config.yaml
```

Edit `config.yaml` — at minimum fill in:

| Key | Where to get it |
|---|---|
| `tmdb.api_key` | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — free account |
| `library[].token` (Plex) | Plex Web → Account → Authorized Devices → token in URL |
| `library[].api_key` (Jellyfin) | Jellyfin Dashboard → API Keys |
| `dvr.url` | TVHeadend: `http://192.168.1.10:9981` · Plex: `http://plex:32400` |
| `dvr.token` (Plex) | Same Plex token as the library checker |

> `config.yaml` is gitignored and never committed — keep your tokens safe.

### 4. First run (dry-run)

```sh
docker compose up
```

`dry_run: true` is the default. Nothing is written to the DVR. The image is pulled automatically from Docker Hub. Check the logs and open the dashboard at **http://localhost:3000** to verify match quality.

### 5. Enable scheduling

Once the matches look correct, flip the flag in `config.yaml`:

```yaml
scheduler:
  dry_run: false
  mode: polling          # runs every interval_minutes
  interval_minutes: 60
```

Then run in the background:

```sh
docker compose up -d
```

---

## Configuration reference

```yaml
# --- Watchlist sources (at least one required) ---
sources:
  # Auto-download: fetches directly from IMDb using a session cookie.
  # Cookie = value of "at-main" from DevTools → Application → Cookies.
  # The Sources tab in the web UI shows last fetch status + manual refresh button.
  - type: imdb_auto
    user_id: "ur12345678"   # urXXXXXXX from your IMDb profile URL
    cookie: ""              # at-main cookie value from your browser
    lists:
      - watchlist           # movies you've marked "Want to See"
      - ratings             # movies you've rated on IMDb
    min_rating: 1           # skip rated movies below this score (1–10)
    # poll_timeout_seconds: 120   # optional: max wait for IMDb export (default: 120)
    # poll_interval_seconds: 4    # optional: polling cadence in seconds (default: 4)

  # Public lists: no authentication needed.
  # Any public IMDb URL: charts (Top 250, Popular, MovieMeter) or public user lists.
  # - type: imdb_public_lists
  #   lists:
  #     - https://www.imdb.com/chart/top/        # IMDb Top 250
  #     - https://www.imdb.com/chart/popular/
  #     - https://www.imdb.com/list/ls000024621/ # public user list

  # Manual CSV: drop exported files into a directory.
  # - type: imdb_csv
  #   path: /data           # directory — all .csv files are loaded automatically
  #   min_rating: 5         # for ratings CSVs: only include movies rated ≥ this

  # TMDB lists: collections, custom lists, or named endpoints.
  # Uses your existing TMDB API key — no extra account needed.
  # - type: tmdb_lists
  #   lists:
  #     - "collection:9485"    # TMDB franchise collection (e.g. Fast & Furious)
  #     - "collection:645"     # James Bond
  #     - "list:12179"         # any public TMDB custom list
  #     - "top_rated"          # named endpoint: popular | top_rated | now_playing | upcoming
  #   pages: 3                 # pages to fetch for named endpoints (collections ignore this)

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
  # sync_watchlist:             # optional — sync all collected IMDb IDs to your TMDB watchlist each run
  #   session_id: ""            # obtain: see "TMDB watchlist sync" section below

# --- Matching ---
matching:
  preferred_language: de        # ISO 639-1 code
  fallback_languages:
    - en
  strict_year_match: false      # false = skip year check if EPG has no year data
  year_tolerance: 1             # ±N years allowed when EPG has a year
  fuzzy_enabled: false          # opt-in fuzzy fallback (Fuse.js)
  fuzzy_threshold: 0.85         # 0–1, higher = stricter

# --- DVR backend (choose one) ---
dvr:
  type: tvheadend
  url: http://tvheadend:9981
  username: ""                  # leave empty for anonymous access
  password: ""

# --- OR: Plex DVR (requires Plex Pass + tuner + Live TV configured) ---
# dvr:
#   type: plex
#   url: http://plex:32400
#   token: ""
#   library_section_id: 6       # optional: DVR Movies library section ID (default: 6)
#   epg_provider: "tv.plex.providers.epg.xmltv:9"  # required: EPG provider ID
#                                                    # find it: GET /media/providers?X-Plex-Token=...

# --- State / cache ---
state:
  redis_url: redis://redis:6379

# --- Scheduler ---
scheduler:
  mode: polling                 # polling | oneshot
  interval_minutes: 60
  dry_run: true                 # true = log matches, never write to DVR

# --- Notifications (optional) ---
# notifications:
#   - type: ntfy
#     url: https://ntfy.sh/your-topic   # or http://your-ntfy-server/topic
#     token: ""                         # optional — for private/authenticated topics

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
7. EPG events shorter than 60 minutes are discarded before matching — XMLTV guide data occasionally misclassifies TV series episodes as movies (e.g. a 10-minute episode tagged as `type=movie`); the duration floor filters these out

### Why TMDB?

IMDb has no public API for structured multilingual titles. TMDB does:

```
IMDb ID  →  TMDB /find/{id}  →  TMDB /movie/{id}/translations
         →  { de: "Stirb langsam", en: "Die Hard", fr: "Piège de cristal", … }
```

Both lookups are Redis-cached for 7 days and fetched 10 at a time.

---

## IMDb auto-download

The `imdb_auto` source uses the same async export pipeline that IMDb's own web app uses — fully GraphQL-driven. No direct download URLs exist; the export is a background job on IMDb's side.

### How it works

1. **Session warm-up** — visits the IMDb homepage and your watchlist page to acquire the full set of session cookies (`session-id`, `session-token`, `ubid-main`, etc.) that the GraphQL API requires alongside `at-main`.
2. **List ID discovery** — parses the watchlist page to find your watchlist's internal list ID (e.g. `ls056610540`).
3. **Trigger exports** — calls two GraphQL mutations:
   - `createListExport` — queues a watchlist CSV job
   - `createRatingsExport` — queues a ratings CSV job
4. **Poll for completion** — calls `getExports` every few seconds until each export reaches status `READY` (typically 10–30 seconds).
5. **Download** — fetches the CSV files from the time-limited pre-signed S3 URLs that IMDb provides.

### Getting the cookie

| Step | Action |
|---|---|
| 1 | Go to [imdb.com](https://www.imdb.com) and sign in |
| 2 | Open DevTools: `F12` (Windows/Linux) · `Cmd+Option+I` (Mac) |
| 3 | **Application** → **Storage** → **Cookies** → `https://www.imdb.com` |
| 4 | Find **`at-main`** → copy the full **Value** (a long URL-encoded string) |
| 5 | Find your user ID in your profile URL: `imdb.com/user/`**`ur12345678`**`/` |

Paste both into `config.yaml` and restart. The service handles the full export flow — session warm-up, GraphQL mutations, polling, and S3 download — automatically.

### Cookie expiry

The `at-main` cookie expires when you log out of IMDb. When it does:

- The **Sources** tab in the web UI will show the error and when it happened
- The **Refresh** button lets you trigger a retry after you've updated `config.yaml` with a fresh cookie — no restart required
- The rest of the service (matching, scheduling, Trakt, CSV) continues to work normally

---

## Homepage widget

watchlist2dvr exposes a flat `/api/stats` endpoint designed for the [Gethomepage](https://gethomepage.dev) `customapi` widget.

```yaml
- watchlist2dvr:
    icon: mdi-television-play
    href: http://watchlist2dvr:3000
    widget:
      type: customapi
      url: http://watchlist2dvr:3000/api/stats
      refreshInterval: 300000   # 5 min
      mappings:
        - field: total
          label: Total
          format: number
        - field: matched
          label: Matched
          format: number
        - field: scheduled
          label: Scheduled
          format: number
        - field: inLibrary
          label: In Library
          format: number
```

The endpoint returns:

```json
{
  "total": 592,
  "matched": 0,
  "scheduled": 2,
  "inLibrary": 360,
  "ambiguous": 0,
  "unmatched": 230,
  "lastRun": "2026-02-20T12:00:00.000Z",
  "dryRun": false
}
```

All eight fields can be used as `field` values in `mappings`.

---

## Notifications

watchlist2dvr can push a notification every time a recording is successfully scheduled.

### ntfy

[ntfy](https://ntfy.sh) is a simple self-hostable push-notification service. Add one or more entries under `notifications` in `config.yaml`:

```yaml
notifications:
  - type: ntfy
    url: https://ntfy.sh/your-topic        # public topic — no auth needed
    # url: http://your-ntfy-server/topic   # self-hosted
    # token: "YOUR_NTFY_ACCESS_TOKEN"      # required for private/authenticated topics
```

Each scheduled recording sends a message like: `Scheduled: Die Hard (1988)`.

Multiple notifiers are supported — list as many `ntfy` entries as you like (e.g. one for a phone and one for a home server).

---

## TMDB watchlist sync

When enabled, watchlist2dvr resolves every IMDb ID collected from your sources to a TMDB ID and adds it to your TMDB watchlist each run. This keeps your TMDB watchlist in sync with whatever sources you configure (IMDb, Trakt, public lists, etc.).

### Setup

Getting a TMDB `session_id` requires three API calls (one-time):

```sh
# 1. Create a request token
curl "https://api.themoviedb.org/3/authentication/token/new?api_key=YOUR_KEY"
# → copy request_token

# 2. Approve it in the browser
open "https://www.themoviedb.org/authenticate/{request_token}"

# 3. Exchange for a session ID
curl -X POST "https://api.themoviedb.org/3/authentication/session/new?api_key=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"request_token": "..."}'
# → copy session_id
```

Then add to `config.yaml`:

```yaml
tmdb:
  api_key: "YOUR_KEY"
  sync_watchlist:
    session_id: "YOUR_TMDB_SESSION_ID"
```

TMDB watchlist sync runs once per scheduler cycle, right after sources are aggregated (before library check or EPG matching). Items already in your TMDB watchlist are silently skipped.

---

## Web dashboard

Available at `http://localhost:3000` (or your configured port).

| Tab | Content |
|---|---|
| **Watchlist** | All items from the last run — matched, scheduled, in-library, and unmatched, with IMDb links, user ratings, and source badges. Filterable by status and searchable by title. |
| **Upcoming** | Live DVR queue (TVHeadend or Plex subscriptions), filtered to scheduled/recording, sorted by creation time |
| **History** | Last 50 runs — item counts, scheduled count, errors, dry-run indicator; each run expands to show matched movies with their source list |
| **Debug** | TMDB cache size by key prefix, live IMDb ID lookup, scheduled-state viewer, one-click cache clear buttons per cache type |
| **Sources** | Status of each `imdb_auto` source (last fetch time, item count, errors) + refresh button + step-by-step cookie guide |

---

## Caching

| Data | Backend | TTL |
|---|---|---|
| TMDB IMDb → ID | Redis | 7 days |
| TMDB localized titles | Redis | 7 days |
| Plex library index | Redis | 6 hours |
| Jellyfin library index | Redis | 6 hours |
| Scheduled-item state | Redis | 30 days |
| EPG (TVHeadend or Plex) | — | not cached (always live) |
| Plex DVR provider ID | process memory | until restart |

To clear all caches: `docker compose exec redis redis-cli FLUSHDB`  
To force a Plex re-index: `docker compose exec redis redis-cli del plex:library:all:v2`

---

## Docker Compose

The default `docker-compose.yml` runs two services:

| Service | Image |
|---|---|
| `watchlist2dvr` | [`irizzu/watchlist2dvr:latest`](https://hub.docker.com/r/irizzu/watchlist2dvr) (pulled from Docker Hub) |
| `redis` | `redis:7-alpine` with AOF persistence |

Mount your IMDb CSVs and config:

```yaml
volumes:
  - ./config.yaml:/app/config.yaml:ro
  - ./data:/data          # place watchlist.csv and/or ratings.csv here
```

`config.yaml` is gitignored — never committed.

If TVHeadend, Plex, or Jellyfin are accessed via **Tailscale MagicDNS**, add the Tailscale DNS resolver to the compose service:

```yaml
dns:
  - 100.100.100.100
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for project structure, development setup, commit conventions, and how to cut a release.

---

## Roadmap

- [x] IMDb auto-download via session cookie (`imdb_auto` source)
- [x] Public IMDb lists — charts and public user lists (`imdb_public_lists` source)
- [ ] Trakt OAuth flow (currently public watchlist / API key only)
- [ ] Manual match override via web UI
- [x] Notifications on successful schedule — ntfy push alerts (`notifications` config block)
- [ ] Series / episode support
- [x] TMDB lists / collections / named endpoints source (`tmdb_lists`)
- [x] Plex DVR backend (EPG via Plex Live TV + subscriptions API)
- [ ] Jellyfin DVR backend
