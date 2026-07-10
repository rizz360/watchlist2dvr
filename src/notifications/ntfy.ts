import axios from "axios"
import type { Notifier, NotificationEvent } from "./index.js"

/**
 * Sends notifications to an ntfy topic via its HTTP API.
 * https://docs.ntfy.sh/publish/
 */
export class NtfyNotifier implements Notifier {
  constructor(
    /** Full topic URL, e.g. https://ntfy.sh/your-topic or http://ntfy.example.com/my-topic */
    private readonly url: string,
    /** Optional Bearer token for authenticated/private topics. */
    private readonly token?: string,
  ) {}

  async notify(event: NotificationEvent): Promise<void> {
    // Skip if nothing interesting happened
    if (event.scheduled === 0 && event.errors.length === 0) return

    const prefix = event.dryRun ? "[DRY RUN] " : ""

    let title: string
    let body: string
    let tags: string

    if (event.scheduled > 0) {
      title = `${prefix}${event.scheduled} new recording(s) scheduled`
      body = event.titles.join("\n")
      tags = "white_check_mark,movie_camera"
    } else {
      title = `${prefix}Run completed with errors`
      body = event.errors.join("\n")
      tags = "warning"
    }

    const headers: Record<string, string> = {
      Title: title,
      Tags: tags,
    }

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }

    await axios.post(this.url, body, { headers, timeout: 10_000 })
  }
}
