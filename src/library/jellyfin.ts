import axios from "axios"
import type { LibraryChecker } from "./index.js"

interface JellyfinItem {
  ProviderIds?: { Imdb?: string }
}

interface JellyfinResponse {
  Items: JellyfinItem[]
  TotalRecordCount: number
}

export class JellyfinLibraryChecker implements LibraryChecker {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async existsInLibrary(imdbId: string): Promise<boolean> {
    const response = await axios.get<JellyfinResponse>(`${this.baseUrl}/Items`, {
      headers: { "X-Emby-Token": this.apiKey },
      params: {
        anyProviderIdEquals: `imdb.${imdbId}`,
        IncludeItemTypes: "Movie",
        Recursive: true,
        Fields: "ProviderIds",
        Limit: 1,
      },
    })
    return response.data.TotalRecordCount > 0
  }
}
