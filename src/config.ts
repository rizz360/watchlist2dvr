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
  min_rating: z.number().int().min(1).max(10).default(1),
})

const SourceSchema = z.discriminatedUnion("type", [TraktSourceSchema, ImdbCsvSourceSchema])

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
})

const DvrSchema = z.discriminatedUnion("type", [TvheadendDvrSchema, PlexDvrSchema])

const ConfigSchema = z.object({
  sources: z.array(SourceSchema).min(1),

  library: z.array(LibrarySchema).optional().default([]),

  tmdb: z.object({
    api_key: z.string().min(1),
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
})

export type Config = z.infer<typeof ConfigSchema>
export type SourceConfig = z.infer<typeof SourceSchema>
export type LibraryConfig = z.infer<typeof LibrarySchema>

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf-8")
  const parsed = yaml.load(raw)
  return ConfigSchema.parse(parsed)
}
