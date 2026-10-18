import type { ActivityDownload, ActivityOverview } from '~/types/activity'
import type { DownloadItem } from '~/types/management'
import { formatClockTime } from './format'

export type DownloadAction = 'cancel' | 'retry' | 'delete'

/** Actions supported by the persisted operation state, not just the display status. */
export function downloadActionsFor(download: DownloadItem): DownloadAction[] {
  const canRetry = download.operationFailed && (download.lastOperation === 'transfer'
    || (download.lastOperation === 'import' && download.importMode === 'jack_manual' && download.importTarget != null))
  if (canRetry)
    return ['retry', 'delete']
  if (download.status === 'downloading')
    return ['cancel', 'delete']
  return ['delete']
}

// jack's own wording on a row it cancelled for the user, and on a row waiting out
// a retry backoff ("Waiting to retry at 14:32: <reason>"). Rows from a jack that
// doesn't send `cancelledByUser` or `phase` are read from these.
const CANCELLED_MESSAGE = 'Download cancelled by user'
const RETRY_WAIT = /^Waiting to retry at (\d{1,2}:\d{2}): ?/

type DownloadRow = DownloadItem & Partial<Pick<ActivityDownload, 'phase' | 'retryAt' | 'cancelledByUser'>>

/** A row the user cancelled. It is stored as failed, but it isn't a failure. */
export function isCancelledDownload(download: DownloadRow): boolean {
  if (download.status !== 'failed')
    return false
  return download.cancelledByUser ?? (download.lastOperation === 'transfer' && download.error === CANCELLED_MESSAGE)
}

export function isRetryWait(download: DownloadRow): boolean {
  if (download.status !== 'downloading')
    return false
  return download.phase === 'retry_wait' || (download.phase == null && RETRY_WAIT.test(download.error ?? ''))
}

/** The failure a row waiting to retry is waiting out, without jack's "Waiting to retry at" prefix. */
export function retryReason(download: DownloadRow): string | null {
  const reason = download.error?.replace(RETRY_WAIT, '').trim()
  return reason || null
}

export type DownloadTone = 'primary' | 'neutral' | 'warning' | 'success' | 'error'

export interface DownloadState {
  label: string
  color: DownloadTone
  // A line under the file name: what went wrong, or what the row waits for.
  note: string | null
  noteTone: 'error' | 'warning' | 'muted'
}

/**
 * What a download row is doing, in words. Waiting rows (for a slot, for a retry)
 * look different from transferring ones, and a cancel is not a failure.
 * `downloadsPaused` comes from Live traffic; queued rows wait for the resume then.
 */
export function downloadState(download: DownloadRow, { downloadsPaused = false } = {}): DownloadState {
  switch (download.status) {
    case 'downloading': {
      if (isRetryWait(download)) {
        const at = formatClockTime(download.retryAt) || RETRY_WAIT.exec(download.error ?? '')?.[1] || ''
        const reason = retryReason(download)
        return {
          label: at ? `Retrying at ${at}` : 'Retrying soon',
          color: 'warning',
          note: reason ? `Attempt ${download.attempts} failed: ${reason}` : null,
          noteTone: 'muted',
        }
      }
      if (download.phase === 'queued') {
        return downloadsPaused
          ? { label: 'Paused', color: 'neutral', note: 'Downloads are paused. This one starts when you resume them.', noteTone: 'muted' }
          : { label: 'Waiting for a free slot', color: 'neutral', note: null, noteTone: 'muted' }
      }
      return { label: 'Downloading', color: 'primary', note: download.error, noteTone: 'warning' }
    }
    case 'import_queued':
      return { label: 'Import queued', color: 'warning', note: download.error, noteTone: 'warning' }
    case 'imported':
      return { label: 'Imported', color: 'success', note: null, noteTone: 'muted' }
    case 'failed':
      if (isCancelledDownload(download))
        return { label: 'Cancelled', color: 'neutral', note: 'You cancelled it. Retry continues from the partial file.', noteTone: 'muted' }
      return { label: 'Failed', color: 'error', note: download.error ?? 'Unknown error', noteTone: 'error' }
    default:
      return { label: String(download.status), color: 'neutral', note: download.error, noteTone: 'muted' }
  }
}

/** The filter chips on the Downloads page, in order. `active` is the default. */
export const DOWNLOAD_FILTERS = ['active', 'downloading', 'import_queued', 'failed', 'cancelled', 'imported', 'all'] as const
export type DownloadFilter = typeof DOWNLOAD_FILTERS[number]

/** A filter from the address bar (`/downloads?status=failed`), or null when it names none. */
export function parseDownloadFilter(value: unknown): DownloadFilter | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && (DOWNLOAD_FILTERS as readonly string[]).includes(raw) ? raw as DownloadFilter : null
}

export function matchesDownloadFilter(download: DownloadRow, filter: DownloadFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return download.status === 'downloading' || download.status === 'import_queued'
        || (download.status === 'failed' && !isCancelledDownload(download))
    case 'failed':
      return download.status === 'failed' && !isCancelledDownload(download)
    case 'cancelled':
      return isCancelledDownload(download)
    default:
      return download.status === filter
  }
}

/** Failed rows (not cancelled ones) that Retry can start again. */
export function retryableFailures<T extends DownloadRow>(downloads: readonly T[]): T[] {
  return downloads.filter(d => matchesDownloadFilter(d, 'failed') && downloadActionsFor(d).includes('retry'))
}

/**
 * The Dashboard's counts. Waiting is a running download without a slot, or one
 * waiting out a retry; Downloading is the rest of the running ones. Failed leaves
 * out downloads the user cancelled.
 */
export function dashboardDownloadCounts(downloads: Pick<ActivityOverview['downloads'], 'byStatus' | 'byPhase'>) {
  const running = downloads.byStatus.downloading ?? 0
  const waiting = Math.min(running, (downloads.byPhase?.queued ?? 0) + (downloads.byPhase?.retry_wait ?? 0))
  return {
    downloading: running - waiting,
    waiting,
    importQueued: downloads.byStatus.import_queued ?? 0,
    failed: downloads.byStatus.failed ?? 0,
  }
}

const PHASE_ORDER: Record<string, number> = { transferring: 0, retry_wait: 1, queued: 2 }

/** Running downloads with the ones that move first, then retries, then the queue. */
export function sortRunningDownloads<T extends DownloadRow>(downloads: readonly T[]): T[] {
  const rank = (d: T) => PHASE_ORDER[d.phase ?? 'transferring'] ?? 0
  return [...downloads].sort((a, b) => rank(a) - rank(b))
}
