import type { DownloadRecord } from './downloads.repository'

/** The error a download cancelled with POST /downloads/:id/cancel keeps (see isCancelledByUser). */
export const DOWNLOAD_CANCELLED_MESSAGE = 'Download cancelled by user'

/**
 * Where a `downloading` row is right now (kept in memory, so unknown after a
 * restart until the row runs again):
 * - `queued`: waiting for a download slot (all taken, or downloads paused).
 * - `transferring`: holds a slot and is fetching or verifying the file.
 * - `retry_wait`: waiting out the backoff after a failed attempt, until `retryAt`.
 */
export const DOWNLOAD_PHASES = ['queued', 'transferring', 'retry_wait'] as const
export type DownloadPhase = typeof DOWNLOAD_PHASES[number]

export interface DownloadPhaseState {
  phase: DownloadPhase
  /** When the next attempt starts (ISO 8601), while `retry_wait`; otherwise null. */
  retryAt: string | null
}

/** A row whose transfer the user cancelled. It is `failed` (Retry resumes it), but not a failure to report. */
export function isCancelledByUser(record: Pick<DownloadRecord, 'status' | 'lastOperation' | 'error'>): boolean {
  return record.status === 'failed' && record.lastOperation === 'transfer' && record.error === DOWNLOAD_CANCELLED_MESSAGE
}
