# Contributing to watchlist2dvr

Thanks for your interest in contributing!

---

## Project structure

```
src/
├── sources/          # WatchlistSource interface + Trakt, IMDb CSV, IMDb auto-download, TMDB lists adapters
├── library/          # LibraryChecker interface + Plex, Jellyfin adapters
├── resolvers/        # TMDB localization resolver (Redis-cached)
├── matching/
│   ├── normalizer.ts # Deterministic title normalization pipeline
│   └── engine.ts     # Matching logic + fuzzy fallback
├── epg/              # EpgProvider interface + TVHeadend, Plex adapters
├── dvr/              # DvrAdapter interface + TVHeadend, Plex adapters
├── state/
│   ├── redis.ts      # Idempotency state store
│   └── history.ts    # Run history (persisted in Redis)
├── web/
│   └── server.ts     # Express read-only dashboard
├── config.ts         # Config schema (zod) + loader
└── scheduler.ts      # Main orchestration loop
```

Each layer is a swappable adapter behind a shared interface. The matching engine never knows which source, library, EPG, or DVR is in use. Adding a new backend means implementing the relevant interface — no changes to core logic.

---

## Development setup

```sh
npm install
npm run dev          # tsx watch — restarts on file changes (requires local Redis)
npm test             # vitest (all tests, no network calls)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

Tests cover the normalization pipeline and matching engine. All tests run in under 400ms with no network calls.

### Local Redis

```sh
docker run -d -p 6379:6379 redis:7-alpine
```

Or use `docker compose up redis` if you have a `config.yaml` in place.

---

## Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | When to use |
|---|---|
| `feat:` | New feature or source/adapter |
| `fix:` | Bug fix |
| `ci:` | GitHub Actions / Docker / build changes |
| `docs:` | README, CONTRIBUTING, comments only |
| `refactor:` | Code change that doesn't fix a bug or add a feature |
| `test:` | Adding or updating tests |
| `chore:` | Dependency bumps, config changes |

GitHub auto-generates release notes grouped by these prefixes.

---

## Releasing

This project uses [release-please](https://github.com/googleapis/release-please-action) for fully automated releases.

### How it works

After each merge to `main`, release-please inspects the new conventional commits and creates (or updates) a **Release PR**. This PR:

- Bumps the version in `package.json` according to SemVer rules
- Generates / updates `CHANGELOG.md` with entries grouped by commit type
- Stays open and accumulates further changes as more commits land on `main`

When you're ready to ship, **merge the Release PR**. release-please then:

1. Tags the merge commit with the version number
2. Creates a GitHub Release with the generated changelog as release notes
3. Triggers the Docker publish workflow, which pushes `irizzu/watchlist2dvr:<version>` and `irizzu/watchlist2dvr:latest` to Docker Hub

**You never need to manually create tags or write release notes.**

### SemVer rules (from conventional commits)

| Commit prefix | Version bump |
|---|---|
| `fix:`, `deps:` | patch — `1.0.0 → 1.0.1` |
| `feat:` | minor — `1.0.0 → 1.1.0` |
| `feat!:`, `fix!:`, `refactor!:`, etc. | major — `1.0.0 → 2.0.0` |

> `chore:`, `docs:`, `ci:`, `test:` commits do **not** trigger a release PR on their own.

### Forcing a specific version

Add `Release-As: x.y.z` to the **body** of any commit:

```sh
git commit --allow-empty -m "chore: release 2.0.0" -m "Release-As: 2.0.0"
```

### Fixing release notes after merge

Edit the body of the already-merged PR and add an override block — release-please will use it on the next run:

```
BEGIN_COMMIT_OVERRIDE
feat: add ability to override merged commit message
fix: another message
END_COMMIT_OVERRIDE
```
