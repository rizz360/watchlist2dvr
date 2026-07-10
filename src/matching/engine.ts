import Fuse from "fuse.js"
import { normalize, extractYear, stripYearSuffix } from "./normalizer.js"
import type { WatchlistItem } from "../sources/index.js"
import type { EpgEvent } from "../epg/index.js"

export interface MatchingConfig {
  preferredLanguage: string
  fallbackLanguages: string[]
  strictYearMatch: boolean
  yearTolerance: number
  fuzzyEnabled: boolean
  fuzzyThreshold: number
}

export interface MatchResult {
  item: WatchlistItem
  event: EpgEvent
  matchedTitle: string
  matchedLanguage: string
  confidence: "exact" | "suffix" | "fuzzy"
}

export interface AmbiguousResult {
  item: WatchlistItem
  candidates: EpgEvent[]
  reason: string
}

export interface MatchingOutput {
  matches: MatchResult[]
  ambiguous: AmbiguousResult[]
  unmatched: WatchlistItem[]
}

export class MatchingEngine {
  constructor(private readonly config: MatchingConfig) {}

  match(items: WatchlistItem[], events: EpgEvent[]): MatchingOutput {
    const matches: MatchResult[] = []
    const ambiguous: AmbiguousResult[] = []
    const unmatched: WatchlistItem[] = []

    // Pre-normalize all EPG events once
    // Strip trailing year suffix (e.g. "Foo (2025)") before normalization so
    // title comparison works, but capture the year for filtering.
    const normalizedEvents = events.map((e) => ({
      event: e,
      normalizedTitle: normalize(stripYearSuffix(e.title)),
      year: e.year ?? extractYear(e.title) ?? (e.description ? extractYear(e.description) : undefined),
    }))

    for (const item of items) {
      const result = this.matchItem(item, normalizedEvents)
      if (result === null) {
        unmatched.push(item)
      } else if ("candidates" in result) {
        ambiguous.push(result)
      } else {
        matches.push(result)
      }
    }

    return { matches, ambiguous, unmatched }
  }

  private matchItem(
    item: WatchlistItem,
    normalizedEvents: Array<{ event: EpgEvent; normalizedTitle: string; year?: number }>,
  ): MatchResult | AmbiguousResult | null {
    const languages = [this.config.preferredLanguage, ...this.config.fallbackLanguages]

    // Candidate titles in priority order: configured languages first, then the
    // original title (may be the only title available when TMDB has no data).
    const candidates: Array<{ lang: string; title: string }> = []
    for (const lang of languages) {
      const title = item.localizedTitles[lang]
      if (title) candidates.push({ lang, title })
    }
    if (!candidates.some((c) => c.title === item.originalTitle)) {
      candidates.push({ lang: "original", title: item.originalTitle })
    }

    // Remember title hits that were rejected only by the year filter so they
    // can be reported as ambiguous if nothing else matches.
    let yearRejected: AmbiguousResult | null = null

    for (const { lang, title } of candidates) {
      const normalizedTarget = normalize(title)

      // Tier 1: exact match
      const exactHits = normalizedEvents.filter(
        (e) => e.normalizedTitle === normalizedTarget,
      )
      if (exactHits.length > 0) {
        const yearFiltered = this.filterByYear(item.year, exactHits)
        if (yearFiltered.length >= 1) {
          const best = yearFiltered.reduce((a, b) =>
            a.event.startTime <= b.event.startTime ? a : b,
          )
          return { item, event: best.event, matchedTitle: title, matchedLanguage: lang, confidence: "exact" }
        }
        yearRejected ??= this.buildYearAmbiguity(item, title, exactHits)
      }

      // Tier 2: suffix match — EPG title may prefix franchise/series name, e.g.
      //   "James Bond 007 - Man lebt nur zweimal"  →  target: "man lebt nur zweimal"
      // We accept a match when the normalized target is a word-boundary-aligned
      // suffix of the normalized EPG title (preceded by a space or is the full title).
      if (normalizedTarget.length >= 4) {
        const suffixHits = normalizedEvents.filter(
          (e) =>
            e.normalizedTitle !== normalizedTarget &&
            (e.normalizedTitle.endsWith(" " + normalizedTarget)),
        )
        if (suffixHits.length > 0) {
          const yearFiltered = this.filterByYear(item.year, suffixHits)
          if (yearFiltered.length >= 1) {
            const best = yearFiltered.reduce((a, b) =>
              a.event.startTime <= b.event.startTime ? a : b,
            )
            return { item, event: best.event, matchedTitle: title, matchedLanguage: lang, confidence: "suffix" }
          }
          yearRejected ??= this.buildYearAmbiguity(item, title, suffixHits)
        }
      }
    }

    // Tier 3: fuzzy fallback (opt-in)
    if (this.config.fuzzyEnabled) {
      const fuzzy = this.fuzzyMatch(item, normalizedEvents)
      if (fuzzy) return fuzzy
    }

    return yearRejected
  }

  /** Describe why title hits were rejected by the year filter. */
  private buildYearAmbiguity(
    item: WatchlistItem,
    title: string,
    hits: Array<{ event: EpgEvent; normalizedTitle: string; year?: number }>,
  ): AmbiguousResult {
    const epgYears = [...new Set(hits.map((h) => h.year).filter((y): y is number => y !== undefined))]
    const reason =
      epgYears.length === 0
        ? `EPG title "${title}" matched but has no year data (strict year matching is on)`
        : `EPG title "${title}" matched but year differs (EPG: ${epgYears.join(", ")}; expected ${item.year}±${this.config.yearTolerance})`
    return { item, candidates: hits.map((h) => h.event), reason }
  }

  private filterByYear(
    itemYear: number | undefined,
    candidates: Array<{ event: EpgEvent; normalizedTitle: string; year?: number }>,
  ) {
    if (!itemYear) return candidates

    const withYear = candidates.filter((c) => c.year !== undefined)
    if (withYear.length === 0) {
      // EPG has no year data — return all candidates if strict mode is off
      return this.config.strictYearMatch ? [] : candidates
    }

    return withYear.filter(
      (c) => Math.abs((c.year as number) - itemYear) <= this.config.yearTolerance,
    )
  }

  private fuzzyMatch(
    item: WatchlistItem,
    normalizedEvents: Array<{ event: EpgEvent; normalizedTitle: string; year?: number }>,
  ): MatchResult | null {
    const titles = [
      item.localizedTitles[this.config.preferredLanguage],
      ...this.config.fallbackLanguages.map((l) => item.localizedTitles[l]),
      item.originalTitle,
    ].filter(Boolean) as string[]

    const fuse = new Fuse(normalizedEvents, {
      keys: ["normalizedTitle"],
      threshold: 1 - this.config.fuzzyThreshold,
      includeScore: true,
    })

    for (const title of titles) {
      const results = fuse.search(normalize(title))
      if (results.length > 0 && results[0].item) {
        const best = results[0]
        const yearFiltered = this.filterByYear(item.year, [best.item])
        if (yearFiltered.length > 0) {
          return {
            item,
            event: best.item.event,
            matchedTitle: title,
            matchedLanguage: "fuzzy",
            confidence: "fuzzy",
          }
        }
      }
    }

    return null
  }
}
