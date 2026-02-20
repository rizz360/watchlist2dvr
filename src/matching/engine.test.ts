import { describe, it, expect } from "vitest"
import { MatchingEngine } from "./engine.js"
import type { WatchlistItem } from "../sources/index.js"
import type { EpgEvent } from "../epg/index.js"

const cfg = {
  preferredLanguage: "de",
  fallbackLanguages: ["en"],
  strictYearMatch: false,
  yearTolerance: 1,
  fuzzyEnabled: false,
  fuzzyThreshold: 0.85,
}

function makeItem(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    imdbId: "tt0095016",
    originalTitle: "Die Hard",
    localizedTitles: { de: "Stirb langsam", en: "Die Hard" },
    year: 1988,
    addedAt: new Date(),
    source: "watchlist",
    ...overrides,
  }
}

function makeEvent(overrides: Partial<EpgEvent> = {}): EpgEvent {
  return {
    eventId: "evt-1",
    title: "Stirb langsam",
    startTime: new Date("2026-03-01T20:15:00Z"),
    endTime: new Date("2026-03-01T22:30:00Z"),
    channelId: "ch-1",
    channelName: "ARD",
    description: "Action film (1988)",
    ...overrides,
  }
}

describe("MatchingEngine", () => {
  const engine = new MatchingEngine(cfg)

  it("matches on preferred language (exact)", () => {
    const { matches, unmatched } = engine.match([makeItem()], [makeEvent()])
    expect(matches).toHaveLength(1)
    expect(matches[0].matchedLanguage).toBe("de")
    expect(matches[0].confidence).toBe("exact")
    expect(unmatched).toHaveLength(0)
  })

  it("falls back to English when German title not found in EPG", () => {
    const { matches } = engine.match(
      [makeItem()],
      [makeEvent({ title: "Die Hard" })],
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].matchedLanguage).toBe("en")
  })

  it("returns unmatched when no EPG event found", () => {
    const { unmatched } = engine.match(
      [makeItem()],
      [makeEvent({ title: "Totally Unrelated Film" })],
    )
    expect(unmatched).toHaveLength(1)
  })

  it("filters by year when EPG description contains year", () => {
    const events = [
      makeEvent({ eventId: "e1", title: "Stirb langsam", description: "(1988)" }),
      makeEvent({ eventId: "e2", title: "Stirb langsam", description: "(2013)" }), // remake year
    ]
    const { matches } = engine.match([makeItem()], events)
    expect(matches).toHaveLength(1)
    expect(matches[0].event.eventId).toBe("e1")
  })

  it("strips edition markers before matching", () => {
    const { matches } = engine.match(
      [makeItem({ localizedTitles: { de: "Stirb langsam - Extended Edition", en: "Die Hard" } })],
      [makeEvent({ title: "Stirb langsam" })],
    )
    expect(matches).toHaveLength(1)
  })

  it("picks earliest airing when same movie appears multiple times in EPG", () => {
    const events = [
      makeEvent({ eventId: "e-later", title: "Stirb langsam", startTime: new Date("2026-03-10T20:00:00Z") }),
      makeEvent({ eventId: "e-earliest", title: "Stirb langsam", startTime: new Date("2026-03-01T20:00:00Z") }),
      makeEvent({ eventId: "e-middle", title: "Stirb langsam", startTime: new Date("2026-03-05T20:00:00Z") }),
    ]
    const { matches, ambiguous } = engine.match([makeItem()], events)
    expect(matches).toHaveLength(1)
    expect(matches[0].event.eventId).toBe("e-earliest")
    expect(ambiguous).toHaveLength(0)
  })
})
