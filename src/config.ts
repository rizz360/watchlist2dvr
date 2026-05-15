import { z } from "zod"
import { readFileSync } from "fs"
import yaml from "js-yaml"

const TraktSourceSchema = z.object({
  type: z.literal("trakt"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  username: z.string().min(1),
})

const ImdbCsvSourceSchema = z.object({
  type: z.literal("imdb_csv"),
  path: z.string().min(1),
  min_rating: z.number().int().min(0).max(10).default(0),
})

const TmdbListsSourceSchema = z.object({
  type: z.literal("tmdb_lists"),
  /**
   * List specs to fetch. Each entry is one of:
   *   "collection:<id>"  — TMDB collection/franchise (e.g. "collection:9485" for Fast & Furious)
   *   "list:<id>"        — any public TMDB custom list
   *   "popular"          — TMDB popular movies (paginated, see `pages`)
   *   "top_rated"        — TMDB top-rated movies
   *   "now_playing"      — currently in cinemas
   *   "upcoming"         — coming soon
   */
  lists: z.array(z.string().min(1)).min(1),
  /** Number of pages to fetch for paginated named endpoints (popular, top_rated, etc). Default: 3 = ~60 movies. */
  pages: z.number().int().min(1).max(20).default(3),
})

const ImdbPublicListsSourceSchema = z.object({
  type: z.literal("imdb_public_lists"),
  /** One or more public IMDb URLs (charts, user lists). Each is fetched once per run. */
  lists: z.array(z.string().url()).min(1),
  /**
   * Additional cookies to send with every request, e.g. aws-waf-token, session-id.
   * Copy values from DevTools: Application → Cookies → https://www.imdb.com
   */
  extra_cookies: z.record(z.string()).optional().default({}),
})

const ImdbAutoSourceSchema = z.object({
  type: z.literal("imdb_auto"),
  /** IMDb user ID, e.g. "ur12345678" — visible in your IMDb profile URL. */
  user_id: z
    .string()
    .regex(/^ur\d+$/, 'Must be a valid IMDb user ID starting with "ur" followed by digits'),
  /** Value of the "at-main" cookie from your browser's DevTools (Application → Cookies). */
  cookie: z.string().min(1),
  /** Which lists to download. Defaults to both watchlist and ratings. */
  lists: z.array(z.enum(["watchlist", "ratings"])).default(["watchlist", "ratings"]),
  /** For ratings lists: skip movies rated below this score (1–10). */
  min_rating: z.number().int().min(1).max(10).default(1),
  /** Max seconds to wait for IMDb to prepare the export (default: 120). */
  poll_timeout_seconds: z.number().int().min(10).max(600).default(120),
  /** Seconds between each poll request while waiting for the export (default: 4). */
  poll_interval_seconds: z.number().int().min(2).max(30).default(4),
  /**
   * Your IMDb watchlist list ID, e.g. "ls056610540".
   * Open your IMDb watchlist in a browser — the URL will contain /list/lsXXXXXXX.
   * Providing this avoids page scraping to discover it (useful when Cloudflare blocks the page).
   */
  watchlist_list_id: z
    .string()
    .regex(/^ls\d{7,10}$/, 'Must be a valid IMDb list ID starting with "ls" followed by 7–10 digits')
    .optional(),
  /**
   * Additional cookies to send with every request, e.g. aws-waf-token, session-id, ubid-main.
   * Copy values from DevTools: Application → Cookies → https://www.imdb.com
   * These are merged with the at-main cookie and any session cookies gathered during warm-up.
   */
  extra_cookies: z.record(z.string()).optional().default({}),
})

const SourceSchema = z.discriminatedUnion("type", [
  TraktSourceSchema,
  ImdbCsvSourceSchema,
  ImdbAutoSourceSchema,
  ImdbPublicListsSourceSchema,
  TmdbListsSourceSchema,
])

const LibraryJellyfinSchema = z.object({
  type: z.literal("jellyfin"),
  url: z.string().url(),
  api_key: z.string().min(1),
})

const LibraryPlexSchema = z.object({
  type: z.literal("plex"),
  url: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  token: z.string().min(1),
})

const LibrarySchema = z.discriminatedUnion("type", [LibraryJellyfinSchema, LibraryPlexSchema])

const TvheadendDvrSchema = z.object({
  type: z.literal("tvheadend"),
  url: z.string().url(),
  username: z.string().default(""),
  password: z.string().default(""),
})

const PlexDvrSchema = z.object({
  type: z.literal("plex"),
  url: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  token: z.string().min(1),
  /** Library section ID for DVR Movies. Defaults to 6 if not specified. */
  library_section_id: z.number().int().positive().optional(),
  /** EPG provider identifier — skips auto-discovery. e.g. tv.plex.providers.epg.xmltv:9 */
  epg_provider: z.string().optional(),
})

const JellyfinDvrSchema = z.object({
  type: z.literal("jellyfin"),
  url: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  api_key: z.string().min(1),
})

const DvrSchema = z.discriminatedUnion("type", [TvheadendDvrSchema, PlexDvrSchema, JellyfinDvrSchema])

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const NtfyNotificationSchema = z.object({
  type: z.literal("ntfy"),
  /** Full topic URL, e.g. https://ntfy.sh/your-topic or http://ntfy.example.com/my-topic */
  url: z.string().url(),
  /** Optional Bearer token for authenticated/private topics. */
  token: z.string().optional(),
})

const NotificationSchema = z.discriminatedUnion("type", [NtfyNotificationSchema])

export type NotificationConfig = z.infer<typeof NotificationSchema>

// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  sources: z.array(SourceSchema).min(1),

  library: z.array(LibrarySchema).optional().default([]),

  tmdb: z.object({
    api_key: z.string().min(1),
    /**
     * If set, all collected watchlist items will be added to your TMDB watchlist each run.
     * Obtain a session_id by authenticating via the TMDB API (see config.yaml.example).
     */
    sync_watchlist: z
      .object({
        session_id: z.string().min(1),
      })
      .optional(),
  }),

  matching: z
    .object({
      preferred_language: z.string().default("en"),
      fallback_languages: z.array(z.string()).default([]),
      strict_year_match: z.boolean().default(false),
      year_tolerance: z.number().int().min(0).default(1),
      fuzzy_enabled: z.boolean().default(false),
      fuzzy_threshold: z.number().min(0).max(1).default(0.85),
    })
    .default({}),

  dvr: DvrSchema,

  state: z
    .object({
      redis_url: z.string().default("redis://localhost:6379"),
    })
    .default({}),

  scheduler: z
    .object({
      mode: z.enum(["polling", "oneshot"]).default("polling"),
      interval_minutes: z.number().int().min(1).default(60),
      dry_run: z.boolean().default(false),
    })
    .default({}),

  web: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().default(3000),
    })
    .default({}),

  notifications: z.array(NotificationSchema).optional().default([]),
})

export type Config = z.infer<typeof ConfigSchema>
export type SourceConfig = z.infer<typeof SourceSchema>
export type LibraryConfig = z.infer<typeof LibrarySchema>

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf-8")
  const parsed = yaml.load(raw)
  return ConfigSchema.parse(parsed)
}
