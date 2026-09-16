export type CheckStatus = 'OK' | 'WARNING' | 'ERROR'

/** One check of the integrity check, in plain language. */
export interface IntegrityCheckItem {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  readonly message: string
}

/**
 * Settings → Maintenance: the integrity check in plain language. It only reports; it never fixes anything. The
 * technical findings stay in the main process log, under `ref`.
 */
export interface IntegrityCheckReport {
  /** The worst status of any check. */
  readonly status: CheckStatus
  readonly message: string
  /** ISO-8601 UTC. */
  readonly checkedAt: string
  readonly checks: readonly IntegrityCheckItem[]
  /** The log reference of the technical details, when a check did not pass; otherwise null. */
  readonly ref: string | null
}
