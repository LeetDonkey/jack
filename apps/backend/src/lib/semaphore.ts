/** A counting semaphore with FIFO fairness for limiting concurrent async work. */
export class Semaphore {
  private permits: number
  // Goes negative after setPermits() lowers the limit below the permits in use;
  // releases then pay that back before anyone else is admitted.
  private available: number
  // While paused nobody new is admitted; holders keep their permits.
  private paused = false
  private readonly waiters: Array<{ resolve: () => void, signal?: AbortSignal, onAbort?: () => void }> = []

  constructor(permits: number) {
    Semaphore.assertPermits(permits)
    this.permits = permits
    this.available = permits
  }

  private static assertPermits(permits: number): void {
    if (!Number.isInteger(permits) || permits < 1)
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`)
  }

  /**
   * Change the limit while in use. Raising it admits waiters right away; lowering
   * it never interrupts holders, it only delays new admissions until enough
   * permits come back.
   */
  setPermits(permits: number): void {
    Semaphore.assertPermits(permits)
    this.available += permits - this.permits
    this.permits = permits
    this.admitWaiting()
  }

  /**
   * Stop admitting anyone (`true`) or start again (`false`). Holders keep their
   * permits and finish; waiters stay queued, in order, until the pause ends.
   */
  setPaused(paused: boolean): void {
    this.paused = paused
    this.admitWaiting()
  }

  get isPaused(): boolean {
    return this.paused
  }

  private admitWaiting(): void {
    while (!this.paused && this.available > 0 && this.waiters.length > 0) {
      this.available--
      this.wake(this.waiters.shift()!)
    }
  }

  private wake(waiter: { resolve: () => void, signal?: AbortSignal, onAbort?: () => void }): void {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.resolve()
  }

  /** `front` joins the head of the queue instead of the tail (e.g. a retry that already had a turn). */
  async acquire(signal?: AbortSignal, { front = false }: { front?: boolean } = {}): Promise<void> {
    signal?.throwIfAborted()
    if (!this.paused && this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: { resolve: () => void, signal?: AbortSignal, onAbort?: () => void } = { resolve, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0)
            this.waiters.splice(index, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      if (front)
        this.waiters.unshift(waiter)
      else
        this.waiters.push(waiter)
    })
  }

  release(): void {
    if (this.available < 0) {
      // Over the (lowered) limit: retire this permit instead of handing it on.
      this.available++
      return
    }
    const next = this.paused ? undefined : this.waiters.shift()
    if (next) {
      // Hand the permit straight to the next waiter (keeps `available` at 0).
      this.wake(next)
      return
    }
    this.available++
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, options?: { front?: boolean }): Promise<T> {
    await this.acquire(signal, options)
    try {
      return await fn()
    }
    finally {
      this.release()
    }
  }
}
