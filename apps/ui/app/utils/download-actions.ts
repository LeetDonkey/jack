import type { ActivityDownload, ActivityOverview } from '~/types/activity'
import type { DestinationRegistration, DownloadItem } from '~/types/management'
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

/**
 * A running download that waits: for a free slot (or for downloads to be
 * resumed), or for its next attempt after a failed one.
 */
export function isWaitingDownload(download: DownloadRow): boolean {
  return download.status === 'downloading' && (download.phase === 'queued' || isRetryWait(download))
}

/**
 * Whether Retry now can start a row waiting to retry early. Not while downloads
 * are paused: the attempt would only wait for the resume.
 */
export function canRetryNow(download: DownloadRow, { downloadsPaused = false } = {}): boolean {
  return !downloadsPaused && isRetryWait(download)
}

/**
 * Why a Retry now failed, from the answer's status and jack's error code:
 * - `stale`: the row stopped waiting (409), or jack no longer has it (jack's own
 *   404, code `NOT_FOUND`).
 * - `unsupported`: a 404 without jack's error code. The route is missing, so
 *   jack is older than jack-ui (the two containers update one at a time).
 * - `error`: any other failure.
 */
export type RetryNowFailure = 'stale' | 'unsupported' | 'error'

export function retryNowFailure(answer: { status: number | undefined, code: string | null }): RetryNowFailure {
  if (answer.status === 409)
    return 'stale'
  if (answer.status === 404)
    return answer.code === 'NOT_FOUND' ? 'stale' : 'unsupported'
  return 'error'
}

const MISSING_FILE = (friend: string) => `${friend} can't find this file right now. Their Radarr/Sonarr may be moving or upgrading it, or a folder is missing in their jack.`

// Failures jack knows, in plain words. A row carries jack's error text and no
// code, so these match that text: Bun's and the system's messages and codes,
// and jack's own errors. `friend` is the friend the file comes from.
// `restates` marks jack's own sentence, which the plain words only reword: the
// row then leaves jack's text out instead of showing the same thing twice.
const PLAIN_FAILURES: ReadonlyArray<{ match: RegExp, text: (friend: string) => string, restates?: true }> = [
  { match: /ENOSPC|no space left/i, text: () => 'The disk where jack saves downloads is full. Free up space, then retry.' },
  { match: /can't find this file on disk/i, text: MISSING_FILE, restates: true },
  { match: /: Not Found$/i, text: MISSING_FILE },
  // A friend's jack answers 503 while its upload slots are full or sharing is
  // paused, and 429 once its daily limit for you is used up. jack keeps only
  // the status text.
  { match: /: (?:503 )?Service Unavailable$/i, text: friend => `${friend}'s jack is busy or has paused sharing.` },
  { match: /: (?:429 )?Too Many Requests$/i, text: friend => `You've downloaded as much from ${friend} today as they allow.` },
  { match: /ECONNRESET|socket connection was closed|ConnectionClosed|EPIPE/i, text: friend => `The connection to ${friend} dropped.` },
  { match: /stalled: no data received/i, text: friend => `No data came from ${friend} for a while.` },
  { match: /timed out|TimeoutError|ETIMEDOUT/i, text: friend => `${friend}'s jack took too long to answer.` },
  { match: /ECONNREFUSED|ConnectionRefused|Unable to connect|FailedToOpenSocket|typo in the url or port|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|EAI_AGAIN|DNSException/i, text: friend => `Can't reach ${friend}'s jack.` },
  { match: /The value of "length" is out of range/, text: () => 'jack ran into an internal error with this file. Retry continues from the partial file.' },
]

/**
 * A transfer failure in plain words, or null when jack's text is not one of the
 * known ones (show it as it is then). Import failures come from Radarr/Sonarr
 * and keep their own text.
 */
export function plainDownloadError(download: Pick<DownloadItem, 'error' | 'peerName' | 'lastOperation'>): string | null {
  const known = knownFailure(download)
  return known ? known.text(download.peerName || 'your friend') : null
}

function knownFailure(download: Pick<DownloadItem, 'error' | 'lastOperation'>) {
  if (!download.error || download.lastOperation !== 'transfer')
    return null
  const reason = download.error.replace(RETRY_WAIT, '')
  return PLAIN_FAILURES.find(failure => failure.match.test(reason)) ?? null
}

// Bun's advice to developers at the end of a fetch error.
const BUN_VERBOSE_HINT = /\s*For more information, pass `verbose: true` in the second argument to fetch\(\)\.?$/

/**
 * jack's own text for a failure the plain words describe, for a tooltip or a
 * Details toggle: null when there is none, or when it says the same as the
 * plain words. Bun's hint for developers is left off.
 */
export function downloadErrorDetail(download: DownloadRow): string | null {
  const known = knownFailure(download)
  if (!known || known.restates)
    return null
  return retryReason(download)?.replace(BUN_VERBOSE_HINT, '') || null
}

const SENTENCE_END = /[.!?]$/
function asSentence(text: string): string {
  return SENTENCE_END.test(text) ? text : `${text}.`
}

export type DownloadTone = 'primary' | 'neutral' | 'warning' | 'success' | 'error'

export interface DownloadState {
  label: string
  color: DownloadTone
  // A line under the file name: what went wrong, or what the row waits for.
  note: string | null
  noteTone: 'error' | 'warning' | 'muted'
  // jack's own error text when the note puts it in plain words and it adds
  // something (downloadErrorDetail): a tooltip, and a Details toggle on phones.
  detail: string | null
}

/**
 * What a download row is doing, in words. Waiting rows (for a slot, for a retry)
 * look different from transferring ones, and a cancel is not a failure.
 * `downloadsPaused` comes from Live traffic; waiting rows wait for the resume then.
 */
export function downloadState(download: DownloadRow, { downloadsPaused = false } = {}): DownloadState {
  const plain = plainDownloadError(download)
  const detail = downloadErrorDetail(download)
  switch (download.status) {
    case 'downloading': {
      if (isRetryWait(download)) {
        const reason = retryReason(download)
        let failure: string | null = null
        if (plain)
          failure = `Attempt ${download.attempts} failed. ${plain}`
        else if (reason)
          failure = `Attempt ${download.attempts} failed: ${reason}`
        if (downloadsPaused) {
          const waits = 'Downloads are paused. This one retries after you resume them.'
          return { label: 'Paused', color: 'neutral', note: failure ? `${waits} ${asSentence(failure)}` : waits, noteTone: 'muted', detail }
        }
        const at = formatClockTime(download.retryAt) || RETRY_WAIT.exec(download.error ?? '')?.[1] || ''
        return { label: at ? `Retrying at ${at}` : 'Retrying soon', color: 'warning', note: failure, noteTone: 'muted', detail }
      }
      if (download.phase === 'queued') {
        return downloadsPaused
          ? { label: 'Paused', color: 'neutral', note: 'Downloads are paused. This one starts when you resume them.', noteTone: 'muted', detail: null }
          : { label: 'Waiting for a free slot', color: 'neutral', note: null, noteTone: 'muted', detail: null }
      }
      return { label: 'Downloading', color: 'primary', note: plain ?? download.error, noteTone: 'warning', detail }
    }
    case 'import_queued':
      return { label: 'Import queued', color: 'warning', note: download.error, noteTone: 'warning', detail: null }
    case 'imported':
      return { label: 'Imported', color: 'success', note: null, noteTone: 'muted', detail: null }
    case 'failed':
      if (isCancelledDownload(download))
        return { label: 'Cancelled', color: 'neutral', note: 'You cancelled it. Retry continues from the partial file.', noteTone: 'muted', detail: null }
      return { label: 'Failed', color: 'error', note: plain ?? download.error ?? 'Unknown error', noteTone: 'error', detail }
    default:
      return { label: String(download.status), color: 'neutral', note: download.error, noteTone: 'muted', detail: null }
  }
}

/** The filter chips on the Downloads page, in order. `active` is the default. */
export const DOWNLOAD_FILTERS = ['active', 'downloading', 'waiting', 'import_queued', 'failed', 'cancelled', 'imported', 'all'] as const
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
    // The Dashboard's split: Waiting is a running download without a slot, or one
    // waiting to retry; Downloading is the rest of the running ones.
    case 'downloading':
      return download.status === 'downloading' && !isWaitingDownload(download)
    case 'waiting':
      return isWaitingDownload(download)
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

/**
 * What the empty Downloads page says: the next step that actually leads to a
 * download. `loading` waits for the answers instead of guessing.
 * - `off`: no downloads block. `restart`: downloads wait for a jack restart.
 * - `no-server`: no Radarr/Sonarr at all. `no-receiver`: none has Download from
 *   friends on, so nothing can receive a download.
 * - `no-friend`: nobody to download from.
 * - `library`: pick something in Friends' library. `library-or-search`: the same,
 *   or search in Radarr/Sonarr, because jack's indexer is in one of them.
 */
export type DownloadsEmptyState = 'loading' | 'off' | 'restart' | 'no-server' | 'no-receiver' | 'no-friend' | 'library' | 'library-or-search'

export interface DownloadsEmptyInput {
  // config/downloads: null when downloads are off, undefined until it is loaded.
  downloadsConfig: object | null | undefined
  downloadsConfigFailed: boolean
  overview: {
    peers: { total: number }
    servers: {
      total: number
      destinations: number
      items: ReadonlyArray<{ destination: boolean, registration: DestinationRegistration | null }>
    }
    system?: { restartPending: readonly string[] }
  } | undefined
  overviewFailed: boolean
}

export function downloadsEmptyState(input: DownloadsEmptyInput): DownloadsEmptyState {
  if (input.downloadsConfig === null)
    return 'off'
  if ((input.downloadsConfig === undefined && !input.downloadsConfigFailed) || (input.overview === undefined && !input.overviewFailed))
    return 'loading'
  const overview = input.overview
  // Without the overview, only the step that never claims too much.
  if (!overview)
    return 'library'
  if (overview.system?.restartPending.includes('downloads'))
    return 'restart'
  if (overview.servers.total === 0)
    return 'no-server'
  if (overview.servers.destinations === 0)
    return 'no-receiver'
  if (overview.peers.total === 0)
    return 'no-friend'
  // jack is an indexer in Radarr/Sonarr only where it added one and the *arr's test of it didn't fail.
  const indexer = overview.servers.items.some(s =>
    s.destination && s.registration?.indexer.status === 'ok' && s.registration.indexerTest !== 'failed')
  return indexer ? 'library-or-search' : 'library'
}
