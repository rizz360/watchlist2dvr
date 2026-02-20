export interface LibraryChecker {
  /** Returns true if the movie identified by imdbId already exists in the library. */
  existsInLibrary(imdbId: string): Promise<boolean>
}

export class NoopLibraryChecker implements LibraryChecker {
  async existsInLibrary(_imdbId: string): Promise<boolean> {
    return false
  }
}
