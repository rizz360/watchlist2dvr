# Plex DVR Scheduling Debug Log

Date: 2026-04-24
Context: `watchlist2dvr` scheduling to Plex DVR created empty entries (movie row with no linked title).

## Goal

Determine, by direct CLI/API experiments (before code edits), which request shape produces valid Plex DVR movie subscriptions.

## Baseline

- Initial subscriptions count: 35
- EPG provider ID detected from `/media/providers`: 10
- Example EPG movie ratingKey from `/tv.plex.providers.epg.xmltv:9/grid`:
  - `tv%2Eplex%2Exmltv%3A%2F%2Fmovie%2FMatrix%2520Revolutions%2520%25282003%2529`

Known good historical movie subscriptions (already in Plex) have:
- `Video.ratingKey` (double-encoded style)
- `Video.guid` (e.g. `tv.plex.xmltv://movie/...`)
- `Video.title`
- `airingsType: "New Airings Only"`

Broken test-created subscriptions had only partial metadata (usually just `Video.ratingKey` and `mediaProviderID`), and showed up as empty entries.

## Experiment 1: Encoding-only variants

Request shape:
- `POST /media/subscriptions`
- query params included:
  - `X-Plex-Token`
  - `type=1`
  - `targetLibrarySectionID=6`
  - `params[mediaProviderID]=10`
  - `prefs[oneShot]=true`
  - `hints[ratingKey]=...`

Variants tested:
1. Raw EPG eventId as `hints[ratingKey]`
2. `encodeURIComponent(eventId)`
3. `encodeURIComponent(encodeURIComponent(eventId))`

Result:
- All 3 returned HTTP 200 and created a subscription row.
- All 3 produced empty/broken movie entries (`Video.title = null`).
- Conclusion: encoding alone is insufficient.

## Experiment 2: Additional hints fields

Single EPG event used:
- ratingKey: `tv%2Eplex%2Exmltv%3A%2F%2Fmovie%2FGodzilla%2520II%253A%2520King%2520of%2520The%2520Monsters%2520%25282019%2529`
- guid: `tv.plex.xmltv://movie/Godzilla%20II%3A%20King%20of%20The%20Monsters%20%282019%29`
- key: `/tv.plex.providers.epg.xmltv:9/metadata/tv%2Eplex%2Exmltv%3A%2F%2Fmovie%2FGodzilla%2520II%253A%2520King%2520of%2520The%2520Monsters%2520%25282019%2529`
- title: `Godzilla II: King of The Monsters (2019)`

Variants and outcomes:

1. `hints[ratingKey]` only
- Created entry
- `Video.title = null`
- Broken/empty

2. `hints[ratingKey] + hints[guid]`
- Created entry
- `Video.guid` populated
- `Video.title = null`
- Still broken/empty in UI

3. `hints[guid]` only
- Created entry
- `Video.title = null`, `Video.ratingKey = null`
- Broken/empty

4. `hints[ratingKey] + hints[guid] + hints[title]`
- Created entry
- `Video.title` populated
- `Video.guid` populated
- Appears as linked/non-empty

5. `hints[key]` only
- Created entry
- No useful movie metadata
- Broken/empty

6. `hints[ratingKey] + hints[key] + hints[guid] + hints[title]`
- Created entry
- `Video.title` and `Video.guid` populated
- Appears as linked/non-empty

## Confirmed Working vs Not Working

Working (non-empty movie subscription):
- `hints[ratingKey]` + `hints[guid]` + `hints[title]`
- Optional: include `hints[key]` as extra context

Not working (empty entry):
- Any request that omits `hints[title]`
- Encoding-only changes of `hints[ratingKey]`
- `hints[key]` alone

## Cleanup Performed

All test subscriptions created in this session were removed.

Deleted keys: `1699,1700,1701,1702,1703,1704,1705,1706,1707`

Deletion endpoint that worked:
- `DELETE /media/subscriptions/{key}?X-Plex-Token=...`

## Code Changes Implemented (2026-05-15)

✅ Plex DVR adapter now receives full EPG context from scheduler:
- Extended `DvrScheduleHints` type with airing metadata: `channelId`, `channelName`, `startTime`, `endTime`, `description`
- Updated Plex EPG provider to extract all airings + dedupe channels from EPG Media array
- Plex DVR adapter now sends UI-aligned parameter set (20+ params) including:
  - Full prefs block (quality, offsets, comskip, one-shot, etc.)
  - `targetSectionLocationID` (critical for full subscription type)
  - Optional `params[airingChannels]` and `params[airingTimes]` from EPG
- Result: subscriptions now have `airingsType="New Airings Only"` and populated `nextScheduledRecording`

✅ Jellyfin DVR adapter fully implemented (2026-05-15):
- **EPG Provider** (`src/epg/jellyfin.ts`): Uses `/Items` endpoint with `includeItemTypes=LiveTvProgram` to search broadcasts
- **DVR Adapter** (`src/dvr/jellyfin.ts`): POSTs to `/LiveTv/SeriesTimers` with JSON body
- **Scheduler wiring**: Full hints passed including Jellyfin-specific fields (serverId, serviceName, externalProgramId)
- **Config schema**: Added JellyfinDvrSchema with type/url/api_key
- **Testing**: Verified EPG search finds "After Love (2021)" broadcasts and scheduling POST succeeds

## Verified Working

- Plex DVR: "After Love (2021)" and "Dragonball Z: Kampf der Götter (2013)" subscriptions created with full metadata
- Jellyfin DVR: EPG search locates "After Love (2021)" (2 broadcasts on 2026-05-25), SeriesTimer POST succeeds
- All 42 tests pass
- TypeScript compile clean
