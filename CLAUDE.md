# CLAUDE.md

Guidance for AI coding agents working in this repository. Read CONTRIBUTING.md for the human-facing project structure, commit conventions, and release process — everything there applies here too.

## Commands

```sh
npm test             # vitest — must pass, no network calls allowed in tests
npm run typecheck    # tsc --noEmit
npm run lint         # eslint — keep it at zero errors
npm run dev          # tsx watch; requires local Redis and a config.yaml
```

`config.yaml` is gitignored and holds real credentials — never read values from it into code, docs, or commits. Use `config.yaml.example` as the reference and keep it updated when the config schema in `src/config.ts` changes.

## Architecture in one paragraph

`src/scheduler.ts` orchestrates a pipeline: sources → library filter → scheduled-state filter → TMDB title resolution → EPG search → matching engine → DVR scheduling → run record + notifications. Every external system sits behind a small interface (`WatchlistSource`, `LibraryChecker`, `EpgProvider`, `DvrAdapter`, `Notifier`), so backends are swappable and the matching engine never knows which backend is in use. Adding a backend means implementing the interface and wiring it in `buildDeps()` in scheduler.ts plus the zod schema in `src/config.ts`.

## Non-obvious constraints

### The web dashboard is a single template literal

The entire dashboard (HTML + CSS + client JS) is the return value of `dashboardHtml()` in `src/web/server.ts`. Because it lives inside a backtick template literal:

- The embedded client JS must NOT use backticks or `${}` — use string concatenation.
- Quotes in inline event handlers use the `&quot;` entity trick, e.g. `onclick="statClick(&quot;matched&quot;)"` (eslint rejects `\'` escapes inside template literals).
- All user/API data interpolated into HTML must go through the client-side `esc()` helper (XSS).
- There is no build step for the frontend; the server must be restarted to pick up changes.

### Movie identity

Items are keyed by a single string ID that is either an IMDb ID (`tt1234567`) or a TMDB-sourced pseudo-ID (`tmdb:12345`). Both formats flow through the TMDB resolver, library checkers, and Redis state keys — handle both whenever touching ID logic.

### Redis key families

`tmdb:id:*`, `tmdb:titles:*`, `tmdb:rating:*` (7-day cache), `plex:library:all:v2` / `jellyfin:library:all:v2` (6-hour blobs), `state:scheduled:*` (30-day idempotency TTL — clearing these causes rescheduling), `watchlist-cache:*` (source fallback), `history:runs` (list, capped at 50), `lock:scheduler:run`.

### Commit messages drive releases

release-please parses conventional commits on `main`: `fix:` → patch, `feat:` → minor, `!` → major; `chore:`/`docs:`/`ci:`/`test:` trigger no release. Don't label a user-visible behavior change as `chore`, and don't label a docs-only change as `fix`.

### Scraping-based sources are fragile by design

`imdb-auto` (GraphQL export flow with session-cookie warm-up) and `imdb-public-lists` (HTML/JSON-LD parsing) depend on IMDb internals and Cloudflare/WAF behavior. Error messages there deliberately include user-facing remediation steps (which cookies to copy, config overrides) — preserve that style when editing. Tests for these must use fixture HTML/JSON, never live requests.

### Run records are append-only history

`RunRecord` (src/state/history.ts) is persisted JSON; old records won't have newly added fields. Any new field must be optional and the dashboard must tolerate its absence.
