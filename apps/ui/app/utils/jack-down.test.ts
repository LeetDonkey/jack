import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { createJackDownTracker, JACK_DOWN_AFTER_MS } from './jack-down'

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

function track() {
  const changes: boolean[] = []
  const tracker = createJackDownTracker(down => changes.push(down))
  return { tracker, changes }
}

describe('createJackDownTracker', () => {
  test('a stream that never connected is not jack being down', () => {
    const { tracker, changes } = track()
    tracker.update(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS * 2)
    expect(changes).toEqual([])
  })

  test('jack is down once the stream has been closed for the delay, and back on the next open', () => {
    const { tracker, changes } = track()
    tracker.update(true, true)
    tracker.update(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS - 1)
    expect(changes).toEqual([])
    jest.advanceTimersByTime(1)
    expect(changes).toEqual([true])
    tracker.update(true, true)
    expect(changes).toEqual([true, false])
  })

  test('a reopen that fails again does not start the count over', () => {
    const { tracker, changes } = track()
    tracker.update(true, true)
    tracker.update(false, true)
    // The stream reports "closed" after every failed reopen, every 5 s.
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(5_000)
      tracker.update(false, true)
    }
    expect(changes).toEqual([true])
  })

  test('a drop shorter than the delay never counts as down', () => {
    const { tracker, changes } = track()
    tracker.update(true, true)
    tracker.update(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS / 2)
    tracker.update(true, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS * 2)
    expect(changes).toEqual([])
  })

  test('hiding the tab stops the count and clears down', () => {
    const { tracker, changes } = track()
    tracker.update(true, true)
    tracker.update(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS)
    tracker.update(false, false)
    expect(changes).toEqual([true, false])

    // Hidden time doesn't count.
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS * 2)
    expect(changes).toEqual([true, false])
  })

  test('a stream reopened after a hidden tab keeps the earlier connection', () => {
    const { tracker, changes } = track()
    tracker.update(true, true)
    // Hidden: useOverview lets go of the stream.
    tracker.update(false, false)
    // Shown again while jack is down: the new stream reports (false, never connected).
    tracker.update(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS)
    expect(changes).toEqual([true])
  })

  test('reset forgets the earlier connection', () => {
    const { tracker, changes } = track()
    tracker.update(true, true)
    tracker.update(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS)
    tracker.reset()
    expect(changes).toEqual([true, false])

    tracker.update(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS * 2)
    expect(changes).toEqual([true, false])
  })

  test('reset stops a count that is running', () => {
    const { tracker, changes } = track()
    tracker.update(true, true)
    tracker.update(false, true)
    tracker.reset()
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS * 2)
    expect(changes).toEqual([])
  })
})
