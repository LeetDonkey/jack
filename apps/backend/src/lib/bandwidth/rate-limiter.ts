// How far ahead of the configured rate a caller may run before it has to wait.
// Smooths out timer granularity so small chunks don't each pay a sleep.
const BURST_MS = 250

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done(signal?.reason)
    function done(error?: unknown) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined)
        resolve()
      else
        reject(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A shared byte-rate limiter. Every transfer in one direction calls `take()` for
 * each chunk it moves; callers are scheduled back to back on a single timeline, so
 * the combined throughput stays at the configured rate and concurrent transfers
 * share it in arrival order. A `null` rate means unlimited.
 */
export class RateLimiter {
  private bytesPerSecond: number | null = null
  // performance.now() timestamp at which the timeline is free again.
  private nextFreeAt = 0

  constructor(
    bytesPerSecond: number | null = null,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
  ) {
    this.setRate(bytesPerSecond)
  }

  get rate(): number | null {
    return this.bytesPerSecond
  }

  setRate(bytesPerSecond: number | null): void {
    const next = bytesPerSecond != null && bytesPerSecond > 0 ? bytesPerSecond : null
    if (next === this.bytesPerSecond)
      return
    this.bytesPerSecond = next
    // Drop the backlog scheduled at the old rate.
    this.nextFreeAt = 0
  }

  async take(bytes: number, signal?: AbortSignal): Promise<void> {
    const rate = this.bytesPerSecond
    if (rate == null || bytes <= 0)
      return
    const now = this.now()
    const start = Math.max(now, this.nextFreeAt)
    this.nextFreeAt = start + (bytes / rate) * 1000
    const waitMs = this.nextFreeAt - now - BURST_MS
    if (waitMs > 0)
      await this.sleep(waitMs, signal)
  }
}
