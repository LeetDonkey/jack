import type { ActiveBandwidthLimits } from '../../lib/bandwidth/schedule'
import type { BandwidthConfig } from '../../lib/config'
import type { TransferDirection, TransferInfo } from './transfer-monitor'
import { RateLimiter } from '../../lib/bandwidth/rate-limiter'
import { resolveBandwidthLimits } from '../../lib/bandwidth/schedule'
import { logger } from '../../logger'
import { TransferMonitor } from './transfer-monitor'

// Schedule periods are minute-granular; re-check often enough to switch on time.
const SCHEDULE_CHECK_MS = 30_000

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

/**
 * Owns the shared rate limiters and the live transfer registry. Limits come from
 * the `bandwidth` config block, read through a getter so edits made through the
 * management API apply without a restart; call `refresh()` after such an edit.
 */
export class TransfersService {
  readonly monitor: TransferMonitor
  readonly downloadLimiter = new RateLimiter()
  readonly uploadLimiter = new RateLimiter()
  private limits: ActiveBandwidthLimits = { downloadBytesPerSecond: null, uploadBytesPerSecond: null, periodIndex: null }
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly now: () => Date

  constructor(
    private readonly getBandwidth: () => BandwidthConfig | undefined,
    private readonly getMaxConcurrentDownloads: () => number | null,
    options: { monitor?: TransferMonitor, now?: () => Date } = {},
  ) {
    this.monitor = options.monitor ?? new TransferMonitor()
    this.now = options.now ?? (() => new Date())
    this.refresh()
  }

  start(): void {
    if (this.timer)
      return
    this.timer = setInterval(() => this.refresh(), SCHEDULE_CHECK_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
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
  canStartUpload(): boolean {
    const max = this.maxConcurrentUploads
    return max == null || this.monitor.activeCount('upload') < max
  }

  snapshot(): TransfersSnapshot {
    const transfers = this.monitor.list()
    const summarize = (direction: TransferDirection, maxConcurrent: number | null, limit: number | null): DirectionSummary => {
      const own = transfers.filter(t => t.direction === direction)
      return {
        active: own.length,
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
