import type { ManagementStreamHandlers } from './useManagementStream'
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { JACK_DOWN_AFTER_MS } from '../utils/jack-down'
import { useOverview } from './useOverview'

interface StateRef<T> { value: T }

interface NuxtComposableGlobals {
  useManagement: () => { request: <T>(path: string) => Promise<T> }
  useState: <T>(key: string, init: () => T) => StateRef<T>
  onMounted: (hook: () => void) => void
  onUnmounted: (hook: () => void) => void
  subscribeManagementStream: (path: string, handlers: ManagementStreamHandlers<unknown>, check: () => Promise<void>) => () => void
  document: { hidden: boolean, addEventListener: (type: string, listener: () => void) => void, removeEventListener: (type: string, listener: () => void) => void }
}

const globals = globalThis as unknown as NuxtComposableGlobals
const STUBBED = ['useState', 'useManagement', 'onMounted', 'onUnmounted', 'subscribeManagementStream', 'document'] as const
const original = Object.fromEntries(STUBBED.map(name => [name, globals[name]]))

const states = new Map<string, StateRef<unknown>>()
let mountedHooks: Array<() => void> = []
let unmountedHooks: Array<() => void> = []
let visibilityListeners: Array<() => void> = []
// Each subscription the overview stream got, newest last.
let streams: Array<{ handlers: ManagementStreamHandlers<unknown>, closed: boolean }> = []

function setGlobals() {
  globals.useState = <T>(key: string, init: () => T): StateRef<T> => {
    const existing = states.get(key)
    if (existing)
      return existing as StateRef<T>
    const created = { value: init() } satisfies StateRef<T>
    states.set(key, created)
    return created
  }
  // The first GET never answers: these tests are about the stream.
  globals.useManagement = () => ({ request: () => new Promise(() => {}) })
  globals.onMounted = hook => mountedHooks.push(hook)
  globals.onUnmounted = hook => unmountedHooks.push(hook)
  globals.subscribeManagementStream = (_path, handlers) => {
    const stream = { handlers, closed: false }
    streams.push(stream)
    // Like the real one: the current state right away, here a stream that never opened.
    handlers.onConnection?.(false, false)
    return () => {
      stream.closed = true
    }
  }
  globals.document = {
    hidden: false,
    addEventListener: (_type, listener) => visibilityListeners.push(listener),
    removeEventListener: (_type, listener) => {
      visibilityListeners = visibilityListeners.filter(l => l !== listener)
    },
  }
}

// What a component does with useOverview: call it in setup, then mount.
function mount() {
  mountedHooks = []
  unmountedHooks = []
  const overview = useOverview()
  for (const hook of mountedHooks)
    hook()
  const unmount = [...unmountedHooks]
  return { ...overview, unmount: () => unmount.forEach(hook => hook()) }
}

function setHidden(hidden: boolean) {
  globals.document.hidden = hidden
  for (const listener of [...visibilityListeners])
    listener()
}

const stream = () => streams.at(-1)!

const mounted: Array<() => void> = []

beforeEach(() => {
  jest.useFakeTimers()
  states.clear()
  streams = []
  visibilityListeners = []
  setGlobals()
})

afterEach(() => {
  for (const unmount of mounted.splice(0))
    unmount()
  jest.useRealTimers()
  // Other test files stub some of these themselves.
  Object.assign(globals, original)
})

describe('useOverview jackDown', () => {
  test('turns on after the stream has been closed for a while, and off when it reopens', () => {
    const layout = mount()
    mounted.push(layout.unmount)
    stream().handlers.onConnection?.(true, true)

    stream().handlers.onConnection?.(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS - 1)
    expect(layout.jackDown.value).toBe(false)
    jest.advanceTimersByTime(1)
    expect(layout.jackDown.value).toBe(true)

    stream().handlers.onConnection?.(true, true)
    expect(layout.jackDown.value).toBe(false)
  })

  test('a tab shown again during an outage counts as down, though the new stream never connected', () => {
    const layout = mount()
    mounted.push(layout.unmount)
    stream().handlers.onConnection?.(true, true)

    setHidden(true)
    expect(stream().closed).toBe(true)
    // jack stops while the tab is hidden; the tab is shown again.
    setHidden(false)
    expect(streams).toHaveLength(2)
    expect(layout.hasConnectedOnce.value).toBe(false)

    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS)
    expect(layout.jackDown.value).toBe(true)
  })

  test('a page mounted during an outage reads the state the notice already shows', () => {
    const layout = mount()
    mounted.push(layout.unmount)
    stream().handlers.onConnection?.(true, true)
    stream().handlers.onConnection?.(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS + 8_000)

    const page = mount()
    mounted.push(page.unmount)
    expect(page.jackDown.value).toBe(true)
    // Still one stream: the page shares the layout's.
    expect(streams).toHaveLength(1)
  })

  test('hidden time does not count', () => {
    const layout = mount()
    mounted.push(layout.unmount)
    stream().handlers.onConnection?.(true, true)
    stream().handlers.onConnection?.(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS / 2)
    setHidden(true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS * 2)
    expect(layout.jackDown.value).toBe(false)
  })

  test('signing out clears it, and the next sign-in starts at never connected', () => {
    const layout = mount()
    stream().handlers.onConnection?.(true, true)
    stream().handlers.onConnection?.(false, true)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS)
    expect(layout.jackDown.value).toBe(true)

    layout.unmount()
    expect(layout.jackDown.value).toBe(false)

    const next = mount()
    mounted.push(next.unmount)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS * 2)
    expect(next.jackDown.value).toBe(false)
  })
})

describe('useOverview jackAway', () => {
  test('turns on when the stream closes, stays on while down, and goes when it reopens', () => {
    const layout = mount()
    mounted.push(layout.unmount)
    // The first stream opening: not away before it ever connected.
    expect(layout.jackAway.value).toBe(false)
    stream().handlers.onConnection?.(true, true)

    stream().handlers.onConnection?.(false, true)
    expect(layout.jackAway.value).toBe(true)
    expect(layout.jackDown.value).toBe(false)
    jest.advanceTimersByTime(JACK_DOWN_AFTER_MS)
    expect(layout.jackAway.value).toBe(true)
    expect(layout.jackDown.value).toBe(true)

    stream().handlers.onConnection?.(true, true)
    expect(layout.jackAway.value).toBe(false)
  })

  test('signing out clears it', () => {
    const layout = mount()
    stream().handlers.onConnection?.(true, true)
    stream().handlers.onConnection?.(false, true)
    expect(layout.jackAway.value).toBe(true)
    layout.unmount()
    expect(layout.jackAway.value).toBe(false)
  })
})
