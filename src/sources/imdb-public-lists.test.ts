import { describe, it, expect } from "vitest"
import { walkForTitlesFromLdJson, isCloudflareChallengeHtml } from "./imdb-public-lists.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collect(ldData: unknown): Map<string, { title: string; year?: number }> {
  const found = new Map<string, { title: string; year?: number }>()
  walkForTitlesFromLdJson(ldData, found)
  return found
}

// ---------------------------------------------------------------------------
// walkForTitlesFromLdJson — JSON-LD ItemList (chart pages)
// ---------------------------------------------------------------------------

describe("walkForTitlesFromLdJson", () => {
  it("extracts titles from a standard ItemList with nested item objects", () => {
    const ldData = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "Top 250 Movies",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          item: {
            "@type": "Movie",
            url: "https://www.imdb.com/title/tt0111161/",
            name: "The Shawshank Redemption",
            datePublished: "1994-09-10",
          },
        },
        {
          "@type": "ListItem",
          position: 2,
          item: {
            "@type": "Movie",
            url: "https://www.imdb.com/title/tt0068646/",
            name: "The Godfather",
            datePublished: "1972-03-24",
          },
        },
      ],
    }

    const found = collect(ldData)

    expect(found.size).toBe(2)
    expect(found.get("tt0111161")).toEqual({ title: "The Shawshank Redemption", year: 1994 })
    expect(found.get("tt0068646")).toEqual({ title: "The Godfather", year: 1972 })
  })

  it("extracts title using @id when url is absent", () => {
    const ldData = {
      "@type": "Movie",
      "@id": "https://www.imdb.com/title/tt0468569/",
      name: "The Dark Knight",
      datePublished: "2008-07-18",
    }

    const found = collect(ldData)

    expect(found.size).toBe(1)
    expect(found.get("tt0468569")).toEqual({ title: "The Dark Knight", year: 2008 })
  })

  it("skips entries without a name", () => {
    const ldData = {
      "@type": "Movie",
      url: "https://www.imdb.com/title/tt0111161/",
      // no 'name' field
    }

    const found = collect(ldData)
    expect(found.size).toBe(0)
  })

  it("does not overwrite an already-found entry", () => {
    const ldData = [
      { "@type": "Movie", url: "https://www.imdb.com/title/tt0111161/", name: "First" },
      { "@type": "Movie", url: "https://www.imdb.com/title/tt0111161/", name: "Second" },
    ]

    const found = collect(ldData)
    expect(found.size).toBe(1)
    expect(found.get("tt0111161")?.title).toBe("First")
  })

  it("handles arrays of JSON-LD objects", () => {
    const ldData = [
      { "@type": "Movie", url: "https://www.imdb.com/title/tt0111161/", name: "Film A" },
      { "@type": "Movie", url: "https://www.imdb.com/title/tt0068646/", name: "Film B" },
    ]

    const found = collect(ldData)
    expect(found.size).toBe(2)
  })

  it("returns empty map for non-IMDb data", () => {
    const ldData = {
      "@type": "WebSite",
      name: "IMDb",
      url: "https://www.imdb.com/",
    }

    const found = collect(ldData)
    expect(found.size).toBe(0)
  })

  it("extracts year from startDate when datePublished is absent", () => {
    const ldData = {
      "@type": "Movie",
      url: "https://www.imdb.com/title/tt0111161/",
      name: "Some Film",
      startDate: "1994",
    }

    const found = collect(ldData)
    expect(found.get("tt0111161")?.year).toBe(1994)
  })

  it("leaves year undefined when no date fields are present", () => {
    const ldData = {
      "@type": "Movie",
      url: "https://www.imdb.com/title/tt0111161/",
      name: "Some Film",
    }

    const found = collect(ldData)
    expect(found.get("tt0111161")?.year).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// discoverWatchlistId strategies — tested via regex patterns used in the code
// ---------------------------------------------------------------------------

describe("watchlist list-ID discovery patterns", () => {
  it("finds list ID in canonical link (rel before href)", () => {
    const html = `<link rel="canonical" href="https://www.imdb.com/list/ls056610540/" />`
    const m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/(ls\d{7,10})[/"'][^>]*>/)
    expect(m?.[1]).toBe("ls056610540")
  })

  it("finds list ID in canonical link (href before rel)", () => {
    const html = `<link href="https://www.imdb.com/list/ls056610540/" rel="canonical" />`
    const m = html.match(/<link[^>]+href=["'][^"']*\/(ls\d{7,10})[/"'][^>]*rel=["']canonical["'][^>]*>/)
    expect(m?.[1]).toBe("ls056610540")
  })

  it("finds list ID in meta content attribute", () => {
    const html = `<meta name="pageId" content="ls056610540" />`
    const m = html.match(/<meta[^>]+content=["'](ls\d{7,10})["'][^>]*>/)
    expect(m?.[1]).toBe("ls056610540")
  })

  it("finds list ID in /list/ URL path", () => {
    const html = `<a href="https://www.imdb.com/list/ls056610540/">My Watchlist</a>`
    const m = html.match(/\/list\/(ls\d{7,10})\//)
    expect(m?.[1]).toBe("ls056610540")
  })

  it("finds list ID as bare quoted value", () => {
    const html = `var listId = "ls056610540";`
    const m = html.match(/"(ls\d{7,10})"/)
    expect(m?.[1]).toBe("ls056610540")
  })

  it("does not match IDs that are too short", () => {
    const html = `<a href="/list/ls12345/">short</a>`
    const m = html.match(/\/list\/(ls\d{7,10})\//)
    expect(m).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isCloudflareChallengeHtml
// ---------------------------------------------------------------------------

describe("isCloudflareChallengeHtml", () => {
  it('detects "Just a moment" challenge page', () => {
    const html = `<html><head><title>Just a moment...</title></head><body></body></html>`
    expect(isCloudflareChallengeHtml(html)).toBe(true)
  })

  it("detects cf-browser-verification page", () => {
    const html = `<html><body><form id="cf-browser-verification"></form></body></html>`
    expect(isCloudflareChallengeHtml(html)).toBe(true)
  })

  it("detects cf-challenge-running page", () => {
    const html = `<html><body class="cf-challenge-running"></body></html>`
    expect(isCloudflareChallengeHtml(html)).toBe(true)
  })

  it("detects cf_chl_opt JavaScript variable", () => {
    const html = `<html><body><script>window.cf_chl_opt = {...}</script></body></html>`
    expect(isCloudflareChallengeHtml(html)).toBe(true)
  })

  it("detects Cloudflare + Ray ID combination", () => {
    const html = `<html><body>Performance &amp; security by Cloudflare | Ray ID: abc123def456</body></html>`
    expect(isCloudflareChallengeHtml(html)).toBe(true)
  })

  it("returns false for real IMDb HTML", () => {
    const html = `<html><head><title>IMDb Top 250 Movies</title></head><body>
      <script type="application/ld+json">{"@type":"ItemList"}</script>
    </body></html>`
    expect(isCloudflareChallengeHtml(html)).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(isCloudflareChallengeHtml("")).toBe(false)
  })

  it("is case-insensitive", () => {
    const html = `<html><head><title>JUST A MOMENT...</title></head><body></body></html>`
    expect(isCloudflareChallengeHtml(html)).toBe(true)
  })
})
