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
  confidence: "exact" | "fuzzy"
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

    for (const lang of languages) {
      const title = item.localizedTitles[lang] ?? (lang === item.originalTitle ? item.originalTitle : null)
      if (!title) continue

      const normalizedTarget = normalize(title)

      const exactHits = normalizedEvents.filter(
        (e) => e.normalizedTitle === normalizedTarget,
      )

      if (exactHits.length === 0) continue

      const yearFiltered = this.filterByYear(item.year, exactHits)

      if (yearFiltered.length === 1) {
        return {
          item,
          event: yearFiltered[0].event,
          matchedTitle: title,
          matchedLanguage: lang,
          confidence: "exact",
        }
      }

      if (yearFiltered.length > 1) {
        return {
          item,
          candidates: yearFiltered.map((e) => e.event),
          reason: `Multiple EPG events matched "${title}" after year filtering`,
        }
      }
    }

    // Fuzzy fallback (opt-in)
    if (this.config.fuzzyEnabled) {
      return this.fuzzyMatch(item, normalizedEvents)
    }

    return null
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
