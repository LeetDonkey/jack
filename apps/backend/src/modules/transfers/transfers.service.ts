import type { ActiveBandwidthLimits } from '../../lib/bandwidth/schedule'
import type { BandwidthConfig } from '../../lib/config'
import type { PauseState, PauseTarget } from './pause'
import type { TrafficLedger } from './traffic-ledger'
import type { TransferDirection, TransferInfo } from './transfer-monitor'
import { RateLimiter } from '../../lib/bandwidth/rate-limiter'
import { resolveBandwidthLimits } from '../../lib/bandwidth/schedule'
import { logger } from '../../logger'
import { NOT_PAUSED, pauseState, samePause, secondsUntilResume } from './pause'
import { localDay } from './traffic-ledger'
import { TransferMonitor } from './transfer-monitor'

// Schedule periods are minute-granular; re-check often enough to switch on time.
const SCHEDULE_CHECK_MS = 30_000
// Peers asking while every upload slot is taken retry after this long.
const UPLOAD_BUSY_RETRY_AFTER_S = 60

export interface ServiceTimers {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (timer: ReturnType<typeof setInterval>) => void
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

export interface DirectionSummary {
  active: number
  maxConcurrent: number | null
  bytesPerSecond: number
  limitBytesPerSecond: number | null
}

export interface TransfersSnapshot {
  download: DirectionSummary
  upload: DirectionSummary
  /** Whether sharing (`uploads`) and downloading (`downloads`) are paused, and until when. */
  paused: Record<PauseTarget, PauseState>
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
  private resumeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => Date
  private readonly timers: ServiceTimers
  private readonly getDownloadsPausedUntil: () => string | null | undefined
  // The pauses as of the last refresh(), to tell when one starts or ends.
  private pauses: Record<PauseTarget, PauseState> = { uploads: NOT_PAUSED, downloads: NOT_PAUSED }
  private readonly pauseListeners = new Set<(target: PauseTarget, state: PauseState) => void>()
  private readonly subscribers = new Set<() => void>()

  constructor(
    private readonly getBandwidth: () => BandwidthConfig | undefined,
    private readonly getMaxConcurrentDownloads: () => number | null,
    options: {
      monitor?: TransferMonitor
      now?: () => Date
      ledger?: TrafficLedger
      /** downloads.pausedUntil as stored now (bandwidth.pausedUntil comes with getBandwidth). */
      downloadsPausedUntil?: () => string | null | undefined
      /** Timer functions; tests inject fakes. */
      timers?: ServiceTimers
    } = {},
  ) {
    this.monitor = options.monitor ?? new TransferMonitor()
    this.now = options.now ?? (() => new Date())
    this.timers = options.timers ?? { setInterval, clearInterval, setTimeout, clearTimeout }
    this.ledger = options.ledger
    this.getDownloadsPausedUntil = options.downloadsPausedUntil ?? (() => null)
    this.refresh()
  }

  start(): void {
    this.ledger?.start()
    if (this.timer)
      return
    this.timer = this.timers.setInterval(() => this.refresh(), SCHEDULE_CHECK_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
    // The constructor's refresh() ran before the interval existed, so a pause
    // that ends within the first check interval gets its timer here.
    this.scheduleResume()
  }

  stop(): void {
    if (this.timer)
      this.timers.clearInterval(this.timer)
    this.timer = undefined
    if (this.resumeTimer)
      this.timers.clearTimeout(this.resumeTimer)
    this.resumeTimer = undefined
    this.ledger?.stop()
  }

  /** Re-resolve the limits and pauses in force from the current config and clock. */
  refresh(): void {
    this.refreshPauses()
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

  /** The pause in force now for one direction, read from the config and the clock. */
  pauseState(target: PauseTarget): PauseState {
    const pausedUntil = target === 'uploads' ? this.getBandwidth()?.pausedUntil : this.getDownloadsPausedUntil()
    return pauseState(pausedUntil, this.now())
  }

  /** Called when a pause starts or ends (also when it ends by itself at its time). */
  onPauseChange(listener: (target: PauseTarget, state: PauseState) => void): () => void {
    this.pauseListeners.add(listener)
    return () => this.pauseListeners.delete(listener)
  }

  private refreshPauses(): void {
    const changed: PauseTarget[] = []
    for (const target of ['uploads', 'downloads'] as const) {
      const next = this.pauseState(target)
      if (!samePause(next, this.pauses[target])) {
        this.pauses[target] = next
        changed.push(target)
      }
    }
    for (const target of changed) {
      const state = this.pauses[target]
      logger.info({ what: target, until: state.until, indefinite: state.indefinite }, state.paused ? `Paused ${target}` : `Resumed ${target}`)
      for (const listener of this.pauseListeners) {
        try {
          listener(target, state)
        }
        catch (err) {
          logger.warn({ err }, 'Pause listener failed')
        }
      }
    }
    if (changed.length > 0)
      this.notify()
    this.scheduleResume()
  }

  // The schedule check runs every 30 s; a pause that ends sooner gets its own
  // timer, so it resumes on time.
  private scheduleResume(): void {
    if (this.resumeTimer)
      this.timers.clearTimeout(this.resumeTimer)
    this.resumeTimer = undefined
    if (!this.timer)
      return
    const now = this.now()
    const seconds = Object.values(this.pauses)
      .map(state => secondsUntilResume(state, now))
      .filter((s): s is number => s != null)
    if (seconds.length === 0)
      return
    const ms = Math.min(...seconds) * 1000
    if (ms > SCHEDULE_CHECK_MS)
      return
    this.resumeTimer = this.timers.setTimeout(() => this.refresh(), ms)
    ;(this.resumeTimer as { unref?: () => void }).unref?.()
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber()
      }
      catch {
        // A failing observer must not break the pause bookkeeping.
      }
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
   * null when it can. Checked in order: a pause of sharing, the friend's daily
   * cap, the friend's own slots, then the slots everyone shares.
   *
   * `resumeKey` identifies a Range request's file transfer. A friend's jack
   * fetches large files in 64 MiB windows, one request each; the next window
   * of an upload that was running when sharing was paused is let through the
   * pause, so running uploads finish.
   */
  uploadRefusal(party?: string, resumeKey?: string): UploadRefusal | null {
    const paused = this.pauseState('uploads')
    if (paused.paused && !(resumeKey && this.monitor.isContinuing(resumeKey))) {
      const resumeIn = secondsUntilResume(paused, this.now())
      return { status: 503, retryAfterSeconds: Math.min(resumeIn ?? UPLOAD_BUSY_RETRY_AFTER_S, UPLOAD_BUSY_RETRY_AFTER_S), message: 'Sharing is paused' }
    }
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
      paused: { uploads: this.pauseState('uploads'), downloads: this.pauseState('downloads') },
      schedulePeriod: this.limits.periodIndex,
      transfers,
    }
  }

  /** Transfer starts, ends and speed ticks, and pauses starting or ending. */
  subscribe(subscriber: () => void): () => void {
    const unsubscribe = this.monitor.subscribe(subscriber)
    this.subscribers.add(subscriber)
    return () => {
      unsubscribe()
      this.subscribers.delete(subscriber)
    }
  }
}
