import { describe, it, expect, vi, beforeEach } from "vitest"
import axios from "axios"
import { TvheadendDvrAdapter } from "./tvheadend.js"

vi.mock("axios")
const mockedAxios = vi.mocked(axios, true)

describe("TvheadendDvrAdapter", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("schedules via create_by_event with discovered default config UUID", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        entries: [
          { uuid: "cfg-1", name: "", enabled: true },
        ],
      },
    } as never)
    mockedAxios.post.mockResolvedValueOnce({ data: {} } as never)

    const adapter = new TvheadendDvrAdapter("http://tvh:9981", "user", "pass")
    await adapter.scheduleEvent({ eventId: "12345" })

    expect(mockedAxios.get).toHaveBeenCalledWith("http://tvh:9981/api/dvr/config/grid", {
      auth: { username: "user", password: "pass" },
      params: { limit: 100 },
      timeout: 10_000,
    })

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "http://tvh:9981/api/dvr/entry/create_by_event",
      null,
      {
        auth: { username: "user", password: "pass" },
        params: { event_id: "12345", config_uuid: "cfg-1" },
        timeout: 10_000,
      },
    )
  })

  it("maps upcoming DVR entries and statuses", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        entries: [
          {
            uuid: "rec-1",
            disp_title: "Movie A",
            start: 1700000000,
            stop: 1700003600,
            channel: "ch-1",
            channelname: "Channel One",
            sched_status: "scheduled",
          },
          {
            uuid: "rec-2",
            disp_title: "Movie B",
            start: 1700010000,
            stop: 1700013600,
            channel: "ch-2",
            channelname: "Channel Two",
            sched_status: "recording",
          },
          {
            uuid: "rec-3",
            disp_title: "Movie C",
            start: 1700020000,
            stop: 1700023600,
            channel: "ch-3",
            channelname: "Channel Three",
            sched_status: "completedWarning",
          },
        ],
      },
    } as never)

    const adapter = new TvheadendDvrAdapter("http://tvh:9981", "", "")
    const entries = await adapter.getScheduledEntries()

    expect(mockedAxios.get).toHaveBeenCalledWith("http://tvh:9981/api/dvr/entry/grid_upcoming", {
      auth: undefined,
      params: { limit: 10000, duplicates: 0 },
      timeout: 10_000,
    })

    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ entryId: "rec-1", title: "Movie A", status: "scheduled" })
    expect(entries[1]).toMatchObject({ entryId: "rec-2", title: "Movie B", status: "recording" })
    expect(entries[2]).toMatchObject({ entryId: "rec-3", title: "Movie C", status: "completed" })
  })
})
