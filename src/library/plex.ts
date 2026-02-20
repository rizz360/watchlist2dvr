import axios from "axios"
import type { LibraryChecker } from "./index.js"

interface PlexMediaContainer {
  MediaContainer: {
    totalSize: number
    Metadata?: Array<{ guid?: string; Guid?: Array<{ id: string }> }>
  }
}

export class PlexLibraryChecker implements LibraryChecker {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async existsInLibrary(imdbId: string): Promise<boolean> {
    // Plex uses "imdb://ttXXXXXX" as a GUID
    const guid = `imdb://${imdbId}`
    const response = await axios.get<PlexMediaContainer>(`${this.baseUrl}/library/all`, {
      params: {
        "X-Plex-Token": this.token,
        type: 1, // 1 = Movie
        guid,
      },
      headers: { Accept: "application/json" },
    })
    return (response.data.MediaContainer.totalSize ?? 0) > 0
  }
}
