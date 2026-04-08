export interface NotificationEvent {
  /** Number of new recordings actually scheduled this run. */
  scheduled: number
  /** Titles of the newly scheduled movies. */
  titles: string[]
  /** Any error messages collected during the run. */
  errors: string[]
  /** Whether this was a dry-run (no writes to DVR). */
  dryRun: boolean
}

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>
}

/** Used when no notification services are configured. */
export class NoopNotifier implements Notifier {
  async notify(_event: NotificationEvent): Promise<void> {}
}
