export type TransferDirection = 'download' | 'upload'

export interface TransferInfo {
  id: string
  direction: TransferDirection
  peer: string
  filename: string
  /** Full file size, or null when unknown. */
  totalBytes: number | null
  /** Bytes of the file on the receiving side, including any resumed offset. */
  transferredBytes: number
  bytesPerSecond: number
  etaSeconds: number | null
  startedAt: string
  /** The download row this transfer belongs to (downloads only); null for uploads. */
  downloadId: number | null
}

export interface TransferHandle {
  /** Count bytes moved by this transfer. */
  add: (bytes: number) => void
  /** Update the known full size (e.g. once response headers arrive). */
  setTotalBytes: (totalBytes: number | null) => void
  /** Stop tracking. Safe to call more than once. */
  end: () => void
}

export interface TransferStart {
  direction: TransferDirection
  peer: string
  filename: string
  totalBytes?: number | null
  offsetBytes?: number
  /** Who is on the other end (a peer connector or an api key), for per-peer limits. */
  party?: string
  /** The download row a download belongs to, so the UI can put speed and actions together. */
  downloadId?: number
  /**
   * Identifies one file transfer across requests. A transfer fetched in Range
   * windows ends and restarts every window; a start with the same key shortly
   * after continues the same entry.
   */
  resumeKey?: string
}

interface TrackedTransfer {
  info: Omit<TransferInfo, 'bytesPerSecond' | 'etaSeconds'>
  party?: string
  resumeKey?: string
  sampledBytes: number
  // Bytes moved in each of the last few ticks, newest last.
  samples: number[]
}

// Speed is averaged over this many one-second ticks.
const SPEED_WINDOW_TICKS = 5
const TICK_MS = 1000
// How long an ended transfer with a resumeKey waits for its next window. It stays
// listed meanwhile (so the view doesn't flicker) but holds no upload slot.
const LINGER_MS = 5000

/**
 * Live registry of in-flight peer transfers in both directions. Transfers report
 * the bytes they move; the monitor samples them once a second to derive speed and
 * notifies subscribers on every tick while anything is active, and on start/end.
 */
export class TransferMonitor {
  private readonly transfers = new Map<string, TrackedTransfer>()
  private readonly lingering = new Map<string, { tracked: TrackedTransfer, endedAt: number }>()
  private readonly subscribers = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private nextId = 1

  constructor(
    private readonly timers: {
      setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
      clearInterval: (timer: ReturnType<typeof setInterval>) => void
    } = { setInterval, clearInterval },
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(input: TransferStart): TransferHandle {
    const offset = input.offsetBytes ?? 0
    this.purgeLingering()
    const resumed = input.resumeKey ? this.lingering.get(input.resumeKey) : undefined
    let tracked: TrackedTransfer
    if (resumed && input.resumeKey) {
      this.lingering.delete(input.resumeKey)
      tracked = resumed.tracked
      tracked.info.transferredBytes = offset
      tracked.info.totalBytes = input.totalBytes ?? tracked.info.totalBytes
      tracked.sampledBytes = Math.min(tracked.sampledBytes, offset)
    }
    else {
      tracked = {
        info: {
          id: `${input.direction}-${this.nextId++}`,
          direction: input.direction,
          peer: input.peer,
          filename: input.filename,
          totalBytes: input.totalBytes ?? null,
          transferredBytes: offset,
          startedAt: this.now().toISOString(),
          downloadId: input.downloadId ?? null,
        },
        party: input.party,
        resumeKey: input.resumeKey,
        sampledBytes: offset,
        samples: [],
      }
    }
    const id = tracked.info.id
    this.transfers.set(id, tracked)
    this.ensureTicking()
    this.notify()

    let ended = false
    return {
      add: (bytes) => {
        if (!ended)
          tracked.info.transferredBytes += bytes
      },
      setTotalBytes: (totalBytes) => {
        if (!ended)
          tracked.info.totalBytes = totalBytes
      },
      end: () => {
        if (ended)
          return
        ended = true
        if (this.transfers.get(id) !== tracked)
          return
        this.transfers.delete(id)
        if (tracked.resumeKey)
          this.lingering.set(tracked.resumeKey, { tracked, endedAt: this.now().getTime() })
        if (this.transfers.size === 0 && this.lingering.size === 0)
          this.stopTicking()
        this.notify()
      },
    }
  }

  /** Running transfers in one direction, optionally only those with one party. */
  activeCount(direction: TransferDirection, party?: string): number {
    let count = 0
    for (const transfer of this.transfers.values()) {
      if (transfer.info.direction === direction && (party == null || transfer.party === party))
        count++
    }
    return count
  }

  /**
   * Whether the transfer with this resumeKey is running, or ended its last
   * window recently enough that the next one continues it.
   */
  isContinuing(resumeKey: string): boolean {
    this.purgeLingering()
    if (this.lingering.has(resumeKey))
      return true
    for (const transfer of this.transfers.values()) {
      if (transfer.resumeKey === resumeKey)
        return true
    }
    return false
  }

  list(): TransferInfo[] {
    this.purgeLingering()
    const all = [...this.transfers.values(), ...Array.from(this.lingering.values(), l => l.tracked)]
    return all.map(({ info, samples }) => {
      const bytesPerSecond = samples.length === 0 ? 0 : Math.round(samples.reduce((sum, s) => sum + s, 0) / samples.length)
      const remaining = info.totalBytes == null ? null : Math.max(0, info.totalBytes - info.transferredBytes)
      return {
        ...info,
        bytesPerSecond,
        etaSeconds: remaining == null || bytesPerSecond === 0 ? null : Math.ceil(remaining / bytesPerSecond),
      }
    })
  }

  subscribe(subscriber: () => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  /** Sample every transfer once. Driven by the interval; exposed for tests. */
  tick(): void {
    const hadLingering = this.lingering.size > 0
    this.purgeLingering()
    const sample = (transfer: TrackedTransfer) => {
      // A resume reset subtracts the discarded bytes; never report negative speed.
      transfer.samples.push(Math.max(0, transfer.info.transferredBytes - transfer.sampledBytes))
      if (transfer.samples.length > SPEED_WINDOW_TICKS)
        transfer.samples.shift()
      transfer.sampledBytes = transfer.info.transferredBytes
    }
    for (const transfer of this.transfers.values())
      sample(transfer)
    for (const { tracked } of this.lingering.values())
      sample(tracked)
    if (hadLingering && this.transfers.size === 0 && this.lingering.size === 0)
      this.stopTicking()
    this.notify()
  }

  private purgeLingering(): void {
    const now = this.now().getTime()
    for (const [key, entry] of this.lingering) {
      if (now - entry.endedAt > LINGER_MS)
        this.lingering.delete(key)
    }
  }

  private ensureTicking(): void {
    if (this.timer)
      return
    this.timer = this.timers.setInterval(() => this.tick(), TICK_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private stopTicking(): void {
    if (!this.timer)
      return
    this.timers.clearInterval(this.timer)
    this.timer = undefined
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber()
      }
      catch {
        // A failing observer must not break transfer accounting.
      }
    }
  }
}
