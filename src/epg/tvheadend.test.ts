import { describe, it, expect, vi, beforeEach } from "vitest"
import axios from "axios"
import { TvheadendEpgProvider } from "./tvheadend.js"

vi.mock("axios")
const mockedAxios = vi.mocked(axios, true)

describe("TvheadendEpgProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("queries epg/events/grid by title and maps events", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        totalCount: 1,
        entries: [
          {
            eventId: 98765,
            title: "Die Hard",
            start: 1700000000,
            stop: 1700007200,
            channelUuid: "ch-1",
            channelName: "ZDF",
            summary: "Action movie",
          },
        ],
      },
    } as never)

    const provider = new TvheadendEpgProvider("http://tvh:9981", "user", "pass")
    const results = await provider.searchByTitle("Die Hard")

    expect(mockedAxios.get).toHaveBeenCalledWith("http://tvh:9981/api/epg/events/grid", {
      auth: { username: "user", password: "pass" },
      params: {
        title: "Die Hard",
        limit: 100,
      },
      timeout: 10_000,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      eventId: "98765",
      title: "Die Hard",
      channelId: "ch-1",
      channelName: "ZDF",
      description: "Action movie",
    })
  })
})
