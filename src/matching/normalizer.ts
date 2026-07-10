// Leading articles to strip, by language
const ARTICLES = [
  // English
  "the", "a", "an",
  // German
  "der", "die", "das", "ein", "eine", "einen", "einem", "eines", "einer",
  // French
  "le", "la", "les", "l", "un", "une", "des",
  // Spanish
  "el", "los", "las",
]

const ARTICLE_PATTERN = new RegExp(
  `^(${ARTICLES.join("|")})[\\s]+`,
  "i",
)

// Edition markers to strip from titles (optional leading article: the/a/an/der/die/das)
const EDITION_KEYWORD = "(extended|director'?s?|theatrical|special|unrated|ultimate|collector'?s?)"
const EDITION_SUFFIX = "(cut|edition|version|release)"
const LEADING_ARTICLE = "(?:the|a|an|der|die|das)\\s+"
const EDITION_MARKERS = [
  new RegExp(`\\s*[-–—:]\\s*(?:${LEADING_ARTICLE})?${EDITION_KEYWORD}\\s*${EDITION_SUFFIX}\\b`, "gi"),
  new RegExp(`\\s*\\((?:${LEADING_ARTICLE})?${EDITION_KEYWORD}\\s*${EDITION_SUFFIX}\\)\\s*`, "gi"),
  /\s+(remastered|restored|anniversary edition)\b/gi,
]

// Umlaut normalization map (optional, configurable)
const UMLAUT_MAP: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  Ä: "ae",
  Ö: "oe",
  Ü: "ue",
}

export interface NormalizerOptions {
  normalizeUmlauts?: boolean
}

export function normalize(title: string, options: NormalizerOptions = {}): string {
  let s = title

  // 1. Strip edition markers
  for (const marker of EDITION_MARKERS) {
    s = s.replace(marker, "")
  }

  // 2. Lowercase
  s = s.toLowerCase()

  // 3. Normalize umlauts (optional)
  if (options.normalizeUmlauts) {
    s = s.replace(/[äöüßÄÖÜ]/g, (ch) => UMLAUT_MAP[ch] ?? ch)
  }

  // 4. Strip leading articles
  s = s.replace(ARTICLE_PATTERN, "")

  // 5. Strip diacritical marks (NFD decomposition, then remove combining characters)
  //    e.g. é → e, à → a, ñ → n  (before the umlaut digraph step which needs original chars)
  s = s.normalize("NFD").replace(/\p{M}/gu, "")

  // 6. Remove remaining punctuation (keep alphanumeric + spaces)
  s = s.replace(/[^\p{L}\p{N}\s]/gu, "")

  // 7. Collapse whitespace
  s = s.replace(/\s+/g, " ").trim()

  return s
}

/** Extract a 4-digit year from an EPG description string. */
export function extractYear(text: string): number | undefined {
  const patterns = [
    /\((\d{4})\)/,          // (1995)
    /\[(\d{4})\]/,          // [1995]
    /\|\s*(\d{4})\s*\|/,    // | 1995 |
    /\b((?:19|20)\d{2})\b/, // bare year as last resort
  ]
  for (const pattern of patterns) {
    const m = text.match(pattern)
    if (m) {
      const year = parseInt(m[1], 10)
      if (year >= 1888 && year <= new Date().getFullYear() + 1) {
        return year
      }
    }
  }
  return undefined
}

/**
 * Strip a trailing year suffix from an EPG title, e.g. "Foo (2025)" → "Foo".
 * Many EPG providers (e.g. XMLTV guide.xml) append the release year to the title.
 */
export function stripYearSuffix(title: string): string {
  return title.replace(/\s*[([](?:19|20)\d{2}[)\]]\s*$/, "").trim()
}
