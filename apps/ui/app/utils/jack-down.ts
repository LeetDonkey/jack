/**
 * How long the overview stream has to stay closed, counting only time the tab is
 * visible, before the app says jack isn't answering. Until then the pages keep
 * what jack last sent, with only the "Reconnecting…" badge.
 */
export const JACK_DOWN_AFTER_MS = 12_000

export interface JackDownTracker {
  /** The overview stream's state now, and whether the tab is visible. */
  update: (connected: boolean, visible: boolean) => void
  /** Signed out: forget the earlier connection and stop the timer. */
  reset: () => void
}

export interface JackDownOptions {
  delayMs?: number
  /**
   * Hears every change of "away": the stream connected since sign-in and is
   * closed now, in a visible tab. That is the count running, or run out. A load
   * that fails then most likely failed because jack is gone, so it waits for jack
   * rather than show its error.
   */
  onAway?: (away: boolean) => void
}

/**
 * Decides when jack counts as down: the overview stream connected at some point
 * since sign-in, and has been closed for `delayMs` of visible time since.
 *
 * A hidden tab closes the stream on purpose, so hiding it stops the count and
 * clears "down"; showing it again starts the count over. The reopened stream
 * starts at "never connected", so the earlier connection is remembered here
 * rather than read from the stream.
 *
 * `update` may repeat the same state (each failed reopen reports "closed" again);
 * only a change starts or stops the count. `onChange` hears every change of
 * "down".
 */
export function createJackDownTracker(onChange: (down: boolean) => void, { delayMs = JACK_DOWN_AFTER_MS, onAway }: JackDownOptions = {}): JackDownTracker {
  let seenConnected = false
  // Connected once, closed now and visible: the count runs, or has run out.
  let counting = false
  let down = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function setDown(next: boolean) {
    if (down === next)
      return
    down = next
    onChange(next)
  }

  function setCounting(next: boolean) {
    counting = next
    onAway?.(next)
  }

  function stopTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function update(connected: boolean, visible: boolean) {
    if (connected)
      seenConnected = true
    const closed = seenConnected && !connected && visible
    if (closed === counting)
      return
    setCounting(closed)
    stopTimer()
    if (!closed) {
      setDown(false)
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      setDown(true)
    }, delayMs)
  }

  function reset() {
    seenConnected = false
    if (counting)
      setCounting(false)
    stopTimer()
    setDown(false)
  }

  return { update, reset }
}
