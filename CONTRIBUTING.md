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

Releases are cut manually via git tags. The [release workflow](.github/workflows/release.yml) triggers automatically on any `v*` tag and:

1. Builds a multi-arch Docker image (`linux/amd64` + `linux/arm64`)
2. Pushes `irizzu/watchlist2dvr:<version>` and `irizzu/watchlist2dvr:latest` to Docker Hub
3. Creates a GitHub Release with auto-generated notes from commits since the last tag

### Cutting a release

Using `npm version` (recommended — updates `package.json` and creates the tag):

```sh
npm version patch   # 1.0.0 → 1.0.1  (bug fixes)
npm version minor   # 1.0.0 → 1.1.0  (new features, backwards compatible)
npm version major   # 1.0.0 → 2.0.0  (breaking changes)

git push && git push --tags
```

Or manually:

```sh
git tag v1.2.0 -m "Release v1.2.0"
git push --tags
```

The `docker-publish` workflow continues to push `latest` on every merge to `main` between releases.
