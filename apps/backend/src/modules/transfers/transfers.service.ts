import type { ActiveBandwidthLimits } from '../../lib/bandwidth/schedule'
import type { BandwidthConfig } from '../../lib/config'
import type { TrafficLedger } from './traffic-ledger'
import type { TransferDirection, TransferInfo } from './transfer-monitor'
import { RateLimiter } from '../../lib/bandwidth/rate-limiter'
import { resolveBandwidthLimits } from '../../lib/bandwidth/schedule'
import { logger } from '../../logger'
import { localDay } from './traffic-ledger'
import { TransferMonitor } from './transfer-monitor'

// Schedule periods are minute-granular; re-check often enough to switch on time.
const SCHEDULE_CHECK_MS = 30_000
// Peers asking while every upload slot is taken retry after this long.
const UPLOAD_BUSY_RETRY_AFTER_S = 60

export interface DirectionSummary {
  active: number
  maxConcurrent: number | null
  bytesPerSecond: number
  limitBytesPerSecond: number | null
}

export interface TransfersSnapshot {
  download: DirectionSummary
  upload: DirectionSummary
  /** Index into bandwidth.schedule of the period in force, or null. */
  schedulePeriod: number | null
  transfers: TransferInfo[]
}

/** Why an upload is refused: the HTTP status, a Retry-After and a message for the peer. */
export interface UploadRefusal {
  status: 429 | 503
  retryAfterSeconds: number
  message: string
}

/**
 * Owns the shared rate limiters and the live transfer registry. Limits come from
 * the `bandwidth` config block, read through a getter so edits made through the
 * management API apply without a restart; call `refresh()` after such an edit.
 */
export class TransfersService {
  readonly monitor: TransferMonitor
  readonly downloadLimiter = new RateLimiter()
  readonly uploadLimiter = new RateLimiter()
  /** Bytes per peer and day; absent where nothing needs it (tests). */
  readonly ledger?: TrafficLedger
  private limits: ActiveBandwidthLimits = { downloadBytesPerSecond: null, uploadBytesPerSecond: null, periodIndex: null }
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly now: () => Date

  constructor(
    private readonly getBandwidth: () => BandwidthConfig | undefined,
    private readonly getMaxConcurrentDownloads: () => number | null,
    options: { monitor?: TransferMonitor, now?: () => Date, ledger?: TrafficLedger } = {},
  ) {
    this.monitor = options.monitor ?? new TransferMonitor()
    this.now = options.now ?? (() => new Date())
    this.ledger = options.ledger
    this.refresh()
  }

  start(): void {
    this.ledger?.start()
    if (this.timer)
      return
    this.timer = setInterval(() => this.refresh(), SCHEDULE_CHECK_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
    this.ledger?.stop()
  }

  /** Re-resolve the limits in force from the current config and clock. */
  refresh(): void {
    const next = resolveBandwidthLimits(this.getBandwidth(), this.now())
    const changed = next.downloadBytesPerSecond !== this.limits.downloadBytesPerSecond
      || next.uploadBytesPerSecond !== this.limits.uploadBytesPerSecond
      || next.periodIndex !== this.limits.periodIndex
    this.limits = next
    this.downloadLimiter.setRate(next.downloadBytesPerSecond)
    this.uploadLimiter.setRate(next.uploadBytesPerSecond)
    if (changed) {
      logger.info({
        downloadBytesPerSecond: next.downloadBytesPerSecond,
        uploadBytesPerSecond: next.uploadBytesPerSecond,
        schedulePeriod: next.periodIndex,
      }, 'Bandwidth limits applied')
    }
  }

  get maxConcurrentUploads(): number | null {
    return this.getBandwidth()?.maxConcurrentUploads ?? null
  }

  /** Whether a new upload may start right now. */
  canStartUpload(party?: string): boolean {
    return this.uploadRefusal(party) == null
  }

  /**
   * Why a new upload to `party` (a friend's api key) can't start right now, or
   * null when it can. Checked in order: the friend's daily cap, the friend's own
   * slots, then the slots everyone shares.
   */
  uploadRefusal(party?: string): UploadRefusal | null {
    const bandwidth = this.getBandwidth()
    const dailyGiB = bandwidth?.dailyUploadLimitGiBPerPeer
    if (party && dailyGiB != null && this.ledger && this.ledger.bytesToday('out', party) >= dailyGiB * 1024 ** 3)
      return { status: 429, retryAfterSeconds: this.secondsUntilMidnight(), message: `Daily limit of ${dailyGiB} GiB reached` }
    const perPeer = bandwidth?.maxConcurrentUploadsPerPeer
    if (party && perPeer != null && this.monitor.activeCount('upload', party) >= perPeer)
      return { status: 503, retryAfterSeconds: UPLOAD_BUSY_RETRY_AFTER_S, message: 'Too many concurrent uploads to you' }
    const max = this.maxConcurrentUploads
    if (max != null && this.monitor.activeCount('upload') >= max)
      return { status: 503, retryAfterSeconds: UPLOAD_BUSY_RETRY_AFTER_S, message: 'Too many concurrent uploads' }
    return null
  }

  // Seconds until the server's local date changes, to the minute. Stepping through
  // localDay instead of doing date arithmetic keeps it right across DST changes.
  private secondsUntilMidnight(): number {
    const now = this.now().getTime()
    const today = localDay(new Date(now))
    let seconds = 60
    while (seconds < 26 * 3600 && localDay(new Date(now + seconds * 1000)) === today)
      seconds += 60
    return seconds
  }

  snapshot(): TransfersSnapshot {
    const transfers = this.monitor.list()
    const summarize = (direction: TransferDirection, maxConcurrent: number | null, limit: number | null): DirectionSummary => {
      const own = transfers.filter(t => t.direction === direction)
      return {
        active: this.monitor.activeCount(direction),
        maxConcurrent,
        bytesPerSecond: own.reduce((sum, t) => sum + t.bytesPerSecond, 0),
        limitBytesPerSecond: limit,
      }
    }
    return {
      download: summarize('download', this.getMaxConcurrentDownloads(), this.limits.downloadBytesPerSecond),
      upload: summarize('upload', this.maxConcurrentUploads, this.limits.uploadBytesPerSecond),
      schedulePeriod: this.limits.periodIndex,
      transfers,
    }
  }

  subscribe(subscriber: () => void): () => void {
    return this.monitor.subscribe(subscriber)
  }
}
