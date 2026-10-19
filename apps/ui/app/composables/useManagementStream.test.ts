import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { STREAM_SILENCE_MS, subscribeManagementStream } from './useManagementStream'

// Just enough of EventSource to drive the composable by hand.
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() {
    this.readyState = FakeEventSource.CLOSED
  }

  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  ping() {
    for (const listener of this.listeners.get('ping') ?? [])
      listener()
  }

  // The BFF's 503 while jack is down: the browser gives up on this one.
  fail() {
    this.readyState = FakeEventSource.CLOSED
    this.onerror?.()
  }
}

const globals = globalThis as { EventSource?: unknown }
const original = globals.EventSource
const unsubscribes: Array<() => void> = []

beforeEach(() => {
  jest.useFakeTimers()
  FakeEventSource.instances = []
  globals.EventSource = FakeEventSource
})

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0))
    unsubscribe()
  jest.useRealTimers()
  globals.EventSource = original
})

function subscribe(path = 'overview/stream') {
  const snapshots: unknown[] = []
  const connection: boolean[] = []
  let opens = 0
  unsubscribes.push(subscribeManagementStream(path, {
    onSnapshot: snapshot => snapshots.push(snapshot),
    onConnection: connected => connection.push(connected),
    onOpen: () => opens++,
  }, async () => {}))
  return { snapshots, connection, opens: () => opens }
}

const current = () => FakeEventSource.instances.at(-1)!

describe('subscribeManagementStream', () => {
  test('opens a new connection when nothing arrives for a while', () => {
    const { connection } = subscribe()
    const first = current()
    first.open()

    jest.advanceTimersByTime(STREAM_SILENCE_MS - 1_000)
    expect(FakeEventSource.instances).toHaveLength(1)

    jest.advanceTimersByTime(1_000)
    expect(first.readyState).toBe(FakeEventSource.CLOSED)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(current().url).toBe('/api/management/overview/stream')
    expect(connection.at(-1)).toBe(false)
  })

  test('pings and messages keep the connection', () => {
    const { snapshots } = subscribe()
    current().open()
    for (let i = 0; i < 6; i++) {
      jest.advanceTimersByTime(15_000)
      current().ping()
    }
    jest.advanceTimersByTime(30_000)
    current().message({ n: 1 })
    jest.advanceTimersByTime(30_000)

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(snapshots).toEqual([{ n: 1 }])
  })

  test('also gives up on a connection that never opens', () => {
    subscribe()
    jest.advanceTimersByTime(STREAM_SILENCE_MS)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  test('calls onOpen on the first open and on every reopen', () => {
    const { opens } = subscribe()
    current().open()
    expect(opens()).toBe(1)

    // jack restarts: the stream drops, the BFF answers 503, the composable retries.
    current().fail()
    jest.advanceTimersByTime(5_000)
    expect(FakeEventSource.instances).toHaveLength(2)
    current().open()
    expect(opens()).toBe(2)
  })

  test('calls onOpen right away when joining an open connection', () => {
    subscribe()
    current().open()
    const second = subscribe()
    expect(second.opens()).toBe(1)
  })

  test('stops its timers when the last subscriber leaves', () => {
    subscribe()
    current().open()
    unsubscribes.pop()!()
    jest.advanceTimersByTime(STREAM_SILENCE_MS * 2)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
