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
}

export interface TransferHandle {
  /** Count bytes moved by this transfer. */
  add: (bytes: number) => void
  /** Update the known full size (e.g. once response headers arrive). */
  setTotalBytes: (totalBytes: number | null) => void
  /** Stop tracking. Safe to call more than once. */
  end: () => void
}

interface TrackedTransfer {
  info: Omit<TransferInfo, 'bytesPerSecond' | 'etaSeconds'>
  sampledBytes: number
  // Bytes moved in each of the last few ticks, newest last.
  samples: number[]
}

// Speed is averaged over this many one-second ticks.
const SPEED_WINDOW_TICKS = 5
const TICK_MS = 1000

/**
 * Live registry of in-flight peer transfers in both directions. Transfers report
 * the bytes they move; the monitor samples them once a second to derive speed and
 * notifies subscribers on every tick while anything is active, and on start/end.
 */
export class TransferMonitor {
  private readonly transfers = new Map<string, TrackedTransfer>()
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

  start(input: { direction: TransferDirection, peer: string, filename: string, totalBytes?: number | null, offsetBytes?: number }): TransferHandle {
    const id = `${input.direction}-${this.nextId++}`
    const offset = input.offsetBytes ?? 0
    const tracked: TrackedTransfer = {
      info: {
        id,
        direction: input.direction,
        peer: input.peer,
        filename: input.filename,
        totalBytes: input.totalBytes ?? null,
        transferredBytes: offset,
        startedAt: this.now().toISOString(),
      },
      sampledBytes: offset,
      samples: [],
    }
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
        this.transfers.delete(id)
        if (this.transfers.size === 0)
          this.stopTicking()
        this.notify()
      },
    }
  }

  activeCount(direction: TransferDirection): number {
    let count = 0
    for (const transfer of this.transfers.values()) {
      if (transfer.info.direction === direction)
        count++
    }
    return count
  }

  list(): TransferInfo[] {
    return Array.from(this.transfers.values(), ({ info, samples }) => {
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
    for (const transfer of this.transfers.values()) {
      // A resume reset subtracts the discarded bytes; never report negative speed.
      transfer.samples.push(Math.max(0, transfer.info.transferredBytes - transfer.sampledBytes))
      if (transfer.samples.length > SPEED_WINDOW_TICKS)
        transfer.samples.shift()
      transfer.sampledBytes = transfer.info.transferredBytes
    }
    this.notify()
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
