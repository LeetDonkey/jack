import type { DownloadPhase } from '../downloads/download-state'
import type { DownloadRecord } from '../downloads/downloads.repository'
import { isCancelledByUser } from '../downloads/download-state'
import { getStubInfoHash } from '../torznab/torrent'

/**
 * The torrent's real BitTorrent infohash. jack has no peer wire, but *arr
 * computes this hash from the stub it grabbed and matches torrents/info by it,
 * so it MUST equal the served stub's infohash -- derive it from the same
 * (release title, size) the stub was built from, NOT from peerId:itemId.
 */
export function deriveHash(name: string, size: number): string {
  return getStubInfoHash(name, size)
}

/**
 * The qB category string jack assigns to a destination server. Unique per
 * server so two same-type *arr instances never see each other's torrents.
 */
export function qbCategoryForServer(serverId: string): string {
  return `jack-${serverId}`
}

export type QbState = 'downloading' | 'queuedDL' | 'pausedDL' | 'pausedUP' | 'error'

/**
 * What this process knows about a row beyond the database. Every field is
 * optional: without it the row maps from its stored status alone.
 */
export interface QbLiveState {
  /** DownloadsService.phaseOf(); null when this process runs nothing for the row. */
  phase?: DownloadPhase | null
  /** Downloads are paused (Live traffic): rows that wait don't start. */
  downloadsPaused?: boolean
  /** The row's live transfer (TransferMonitor), while bytes flow. */
  bytesPerSecond?: number
  etaSeconds?: number | null
}

const ETA_UNKNOWN = 8_640_000 // qB's "unknown ETA" sentinel (= 100 days); *arr recognises this specific value as "no ETA"

// How Radarr/Sonarr read each state:
// - downloading: Downloading.
// - queuedDL: Queued. Used for a row waiting for a slot or waiting to retry.
//   stalledDL would be closer for a retry, but *arr shows it as a "stalled"
//   warning, and stalled-download cleaners (Cleanuparr, Decluttarr) strike and
//   remove such torrents, partial file and all, while jack still retries.
// - pausedDL: Paused, for a row that waits while downloads are paused, and for
//   one the user cancelled in jack (Retry there resumes it). *arr neither
//   imports nor blocklists a paused torrent.
// - pausedUP: Completed; *arr imports from content_path.
// - error: a "qBittorrent is reporting an error" warning, without a blocklist.
//   Only for a real failure.
function mapState(record: Pick<DownloadRecord, 'status' | 'lastOperation' | 'error'>, live: QbLiveState): QbState {
  switch (record.status) {
    case 'import_queued':
    case 'imported':
      return 'pausedUP'
    case 'failed':
      return isCancelledByUser(record) ? 'pausedDL' : 'error'
    case 'downloading':
    default:
      // A transfer that is running keeps going during a pause.
      if (live.phase === 'queued' || live.phase === 'retry_wait')
        return live.downloadsPaused ? 'pausedDL' : 'queuedDL'
      return 'downloading'
  }
}

function toEpoch(iso: string | null): number {
  if (!iso)
    return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

export interface QbTorrent {
  hash: string
  name: string
  size: number
  total_size: number
  progress: number
  eta: number
  state: QbState
  category: string
  tags: string
  save_path: string
  content_path: string
  ratio: number
  ratio_limit: number
  seeding_time_limit: number
  amount_left: number
  completed: number
  completion_on: number
  added_on: number
  dlspeed: number
  upspeed: number
  num_seeds: number
  num_complete: number
  num_leechs: number
  num_incomplete: number
}

export function toQbTorrent(record: DownloadRecord, opts: { completedPath: string, category: string, live?: QbLiveState }): QbTorrent {
  const live = opts.live ?? {}
  const size = record.expectedBytes ?? record.releaseSize
  const isDone = record.status === 'import_queued' || record.status === 'imported'
  const progress = isDone ? 1 : (size > 0 ? Math.min(record.downloadedBytes / size, 1) : 0)
  const amountLeft = isDone ? 0 : Math.max(size - record.downloadedBytes, 0)
  const state = mapState(record, live)
  // Speed and time left only while bytes flow; a waiting row has neither.
  const moving = state === 'downloading'
  return {
    // Real stub infohash (from release title + size), NOT peerId:itemId — *arr
    // matches torrents/info to the hash it computed from the grabbed .torrent.
    hash: deriveHash(record.release.title, record.releaseSize),
    name: record.filename,
    size,
    total_size: size,
    progress,
    eta: isDone ? 0 : (moving && live.etaSeconds != null ? live.etaSeconds : ETA_UNKNOWN),
    state,
    category: opts.category,
    tags: '',
    save_path: opts.completedPath,
    content_path: record.destPath, // must differ from save_path or *arr warns "path error"
    ratio: 0,
    ratio_limit: -2,
    seeding_time_limit: -2,
    amount_left: amountLeft,
    completed: isDone ? size : record.downloadedBytes,
    completion_on: toEpoch(record.completedAt),
    added_on: toEpoch(record.startedAt),
    dlspeed: moving ? (live.bytesPerSecond ?? 0) : 0,
    upspeed: 0,
    num_seeds: 1,
    num_complete: 1,
    num_leechs: 0,
    num_incomplete: 0,
  }
}
