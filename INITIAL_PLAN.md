**watchlist2dvr** is a modular automation service that synchronizes a movie watchlist (e.g., IMDb or Trakt) with a DVR backend.


It resolves localized titles (e.g., German, English, etc.), matches them against the DVR’s EPG data, and automatically schedules recordings for upcoming broadcasts.

The system is backend-agnostic via a pluggable adapter layer (initially targeting TVHeadend), allowing future support for other DVR platforms like Plex or Jellyfin without changing the core matching logic.




# High-Level Architecture

We split responsibilities cleanly:

```
IMDb/Trakt Adapter
        ↓
Title Normalization + Localization Resolver
        ↓
Matching Engine (EPG abstraction)
        ↓
DVR Adapter (TVHeadend for now)
```

Each layer becomes replaceable.

---

# Core Design Principles

### 1️⃣ Canonical Identity First — Titles Second

Never match by raw strings alone.

Internal model should look like:

```ts
interface WatchlistItem {
  imdbId: string
  originalTitle: string
  localizedTitles: {
    [languageCode: string]: string
  }
  year?: number
}
```

Matching is done against:

* preferred localized title
* fallback titles
* year proximity
* optional fuzzy threshold

---

# Source of Truth: Use TMDB for Localization

IMDb does not provide structured multilingual title access easily.

Better pattern:

* IMDb ID → TMDB lookup
* TMDB gives:

  * original title
  * German title
  * French title
  * etc.

TMDB API supports:

```
/movie/{id}/translations
```

So your internal resolver can build:

```json
{
  "de": "Stirb langsam",
  "en": "Die Hard",
  "fr": "Piège de cristal"
}
```

This solves your “DVR location” requirement cleanly.

---

# Language Selection Strategy

Configuration:

```yaml
matching:
  preferred_language: de
  fallback_languages:
    - en
  strict_year_match: true
```

Matching algorithm:

1. Try exact match on preferred language
2. If not found → try fallbacks
3. If multiple hits → filter by year ±1
4. If still ambiguous → log + skip

No guessing beyond that unless explicitly enabled.

---

# Matching Engine (EPG Abstraction Layer)

Define an interface:

```ts
interface EpgProvider {
  searchByTitle(title: string): Promise<EpgEvent[]>
}
```

TVHeadend adapter implements it via:

* `/api/epg/events/grid`
* or `/api/epg/events/load`

Later:

* Plex adapter
* Jellyfin adapter

Matching engine never knows which DVR exists.

---

# DVR Adapter Interface

Define:

```ts
interface DvrAdapter {
  scheduleEvent(eventId: string): Promise<void>
  createAutoRecord(title: string): Promise<void>
}
```

TVHeadend implementation:

* `/api/dvr/entry/create`
* `/api/dvr/autorec/create`

Later:

* Plex implementation uses Plex DVR API
* Jellyfin implementation uses ScheduledTask API

This keeps your final step swappable.

---

# Why TVHeadend Is Good First Backend

TVHeadend API is:

* predictable
* REST-like
* stateless
* does not mix metadata layers

So it fits nicely as the first adapter.

---

# Now the Important Part: Title Matching Strategy

This is where most DIY projects fail.

You must normalize:

* remove punctuation
* normalize umlauts (ä → ae optionally)
* strip edition markers ("Extended Cut")
* remove leading articles ("Der", "Die", "The")

Example normalization pipeline:

```
Stirb langsam
↓
stirb langsam
↓
stirb langsam
```

But also:

```
Die Hard - Extended Edition
↓
die hard
```

Use a deterministic cleaning pipeline, not fuzzy magic.

Fuzzy matching should only be fallback, never primary.

---

# Year-Aware Matching

EPG often lacks year. That’s painful.

Strategy:

* If EPG description contains "(1995)" → extract year
* Else:

  * allow ±1 year tolerance
  * or disable year constraint if missing

Make this configurable.

---

# Handling Duplicates & Idempotency

Very important:

Before scheduling:

* Check if already scheduled
* Check if already recorded

TVHeadend allows querying existing DVR entries:

* `/api/dvr/entry/grid`

Store internal state as well (e.g. Redis or SQLite).

Never blindly create entries.

---

# Dockerized Service Layout

Given your infra style:

```
imdb-dvr-sync/
  ├── adapters/
  │     ├── tvheadend.ts
  │     ├── plex.ts
  │     └── jellyfin.ts
  ├── epg/
  ├── matching/
  ├── sources/
  │     ├── trakt.ts
  │     └── imdb.ts
  ├── config.yaml
  └── docker-compose.yml
```

Run as:

* scheduled cron job
* or polling service every X minutes

---

# Recommended Stack for You

Given your setup:

* You already use TVHeadend
* You run multiple Compose stacks
* You prefer reproducible infra

I would build this as:

* Node.js (TypeScript)
* Axios
* Fuse.js (optional fuzzy fallback)
* Redis (optional cache)
* Runs as Docker container

Minimal memory footprint, easy to swap adapters later.

---

# Advanced Option (Future)

If you want this to become robust:

Store canonical mapping:

```
imdbId → epgSeriesLink or channel-specific event identifiers
```

So once matched once, you don’t rely on string matching anymore.

---

# Direct Answer to Your Language Requirement

Yes — we can implement:

```
preferred_language: auto
```

Where:

* It checks TVHeadend channel language
* Or uses container environment variable (e.g. LANG=de_LU)
* Or manual config

Cleaner to just configure explicitly.

---

# Suggested Clean First Milestone

1. Pull Trakt watchlist
2. Resolve TMDB translations
3. Normalize
4. Query TVHeadend EPG
5. Log match candidates only
6. No scheduling yet

Only once matching quality is good → enable scheduling.

# Bonus

- Ability to check Plex or Jellyfin on whether movies exist already in library

---

# Environment

- Docker compose
- Web UI