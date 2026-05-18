# watchlist2dvr

[![Build](https://github.com/rizz360/watchlist2dvr/actions/workflows/docker-publish.yml/badge.svg?branch=main)](https://github.com/rizz360/watchlist2dvr/actions/workflows/docker-publish.yml)
[![Release](https://img.shields.io/github/v/release/rizz360/watchlist2dvr?label=release&logo=github)](https://github.com/rizz360/watchlist2dvr/releases)
[![Docker Image](https://img.shields.io/docker/v/irizzu/watchlist2dvr?label=docker&logo=docker&logoColor=white)](https://hub.docker.com/r/irizzu/watchlist2dvr)
[![Docker Pulls](https://img.shields.io/docker/pulls/irizzu/watchlist2dvr?logo=docker&logoColor=white)](https://hub.docker.com/r/irizzu/watchlist2dvr)
[![Node](https://img.shields.io/badge/node-22-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

Automatically records movies from your watchlist and other movie sources onto your DVR.

It resolves localized titles, skips items already in your library, and schedules the earliest matching airing. The code supports IMDb watchlists and ratings, public IMDb lists, TMDB lists, Trakt, or manual CSV input.

## What it does

- Pulls movies from one or more sources.
- Checks Plex or Jellyfin to skip items you already own.
- Resolves titles through TMDB for your preferred language.
- Matches against TVHeadend, Plex DVR, or Jellyfin Live TV.
- Keeps runs idempotent with Redis-backed state.
- Shows progress in a read-only web dashboard and can send ntfy notifications.

## How it works

1. Collect watchlist items from your configured sources.
2. Skip titles already present in your library.
3. Normalize and localize titles through TMDB.
4. Find upcoming airings in the EPG.
5. Schedule the earliest valid match, unless `dry_run` is enabled.

## Quick start

Deploy with Docker Compose:

```sh
cp config.yaml.example config.yaml
docker compose up -d
```

The compose file uses `irizzu/watchlist2dvr:latest` and pulls the image from Docker Hub automatically. Start by filling in the required config values in `config.yaml`: at minimum a source, `tmdb.api_key`, one library checker if you want ownership checks, and a DVR backend.

If you also want to convert recorded `.ts` files into `.mkv`, this pairs well with [ts-to-mkv](https://github.com/rizz360/ts-to-mkv), a Docker-based tool that preserves folder structure and chooses remux or encode paths with hardware fallback.

## Documentation

The wiki holds the detailed docs so this README can stay short:

- [Wiki home](https://github.com/rizz360/watchlist2dvr/wiki)
- [Configuration reference](https://github.com/rizz360/watchlist2dvr/wiki/Configuration)
- [Source-specific docs](https://github.com/rizz360/watchlist2dvr/wiki/Sources)
- [Matching behavior](https://github.com/rizz360/watchlist2dvr/wiki/Matching)
- [Operations and dashboard](https://github.com/rizz360/watchlist2dvr/wiki/Operations)

For a starting point, copy [config.yaml.example](config.yaml.example) and then use the wiki for the full field-by-field explanation.

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
- [x] Jellyfin DVR backend
