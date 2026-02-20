import { describe, it, expect } from "vitest"
import { normalize, extractYear } from "./normalizer.js"

describe("normalize", () => {
  it("lowercases and strips leading articles", () => {
    expect(normalize("The Dark Knight")).toBe("dark knight")
    expect(normalize("Die Hard")).toBe("hard")
    expect(normalize("Der Pate")).toBe("pate")
    expect(normalize("Les Misérables")).toBe("miserables") // accents stripped via NFD normalization
  })

  it("strips edition markers", () => {
    expect(normalize("Die Hard - Extended Edition")).toBe("hard")
    expect(normalize("Blade Runner: The Director's Cut")).toBe("blade runner")
    expect(normalize("Alien (Theatrical Cut)")).toBe("alien")
  })

  it("removes punctuation", () => {
    expect(normalize("Se7en")).toBe("se7en")
    expect(normalize("Schindler's List")).toBe("schindlers list")
  })

  it("collapses whitespace", () => {
    expect(normalize("  Foo   Bar  ")).toBe("foo bar")
  })

  it("normalizes umlauts when option is set", () => {
    expect(normalize("Stirb langsam", { normalizeUmlauts: true })).toBe("stirb langsam")
    expect(normalize("Die Brücke", { normalizeUmlauts: true })).toBe("bruecke")
  })
})

describe("extractYear", () => {
  it("extracts year in parentheses", () => {
    expect(extractYear("Die Hard (1988) Action film")).toBe(1988)
  })

  it("extracts year in brackets", () => {
    expect(extractYear("Alien [1979]")).toBe(1979)
  })

  it("extracts year with pipes", () => {
    expect(extractYear("Some Film | 2001 | USA")).toBe(2001)
  })

  it("returns undefined when no year present", () => {
    expect(extractYear("Just a description with no year")).toBeUndefined()
  })
})
