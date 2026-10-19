import type { MaybeRefOrGetter } from 'vue'

type SnapshotSubscriber = (snapshot: unknown) => void
type ConnectionSubscriber = (connected: boolean, hasConnectedOnce: boolean) => void
type OpenSubscriber = () => void
type AuthorizationCheck = () => Promise<void>

// How long to wait before reopening a stream the browser gave up on.
const REOPEN_DELAY_MS = 5_000
// jack sends a `ping` event every 15 s on every stream. Nothing for this long means
// the connection died on the way without the browser noticing, so open a new one.
export const STREAM_SILENCE_MS = 45_000

interface SharedManagementStream {
  source: EventSource | undefined
  connected: boolean
  // Set by the first successful open and kept through drops, so a badge can tell
  // "still connecting" apart from "lost the connection".
  hasConnectedOnce: boolean
  reopenTimer: ReturnType<typeof setTimeout> | undefined
  silenceTimer: ReturnType<typeof setTimeout> | undefined
  snapshotSubscribers: Set<SnapshotSubscriber>
  connectionSubscribers: Set<ConnectionSubscriber>
  openSubscribers: Set<OpenSubscriber>
}

const streams = new Map<string, SharedManagementStream>()
let authorizationCheck: Promise<void> | undefined

function verifyAuthorization(check: AuthorizationCheck) {
  authorizationCheck ??= check()
    .catch(() => {})
    .finally(() => authorizationCheck = undefined)
}

// Each subscriber is called on its own, so one that throws can't keep the others
// from hearing about it.
function notify<A extends unknown[]>(subscribers: Set<(...args: A) => void>, ...args: A) {
  for (const subscriber of subscribers) {
    try {
      subscriber(...args)
    }
    catch {}
  }
}

function connect(path: string, stream: SharedManagementStream, checkAuthorization: AuthorizationCheck) {
  const source = new EventSource(`/api/management/${path}`)
  stream.source = source

  const isCurrent = () => stream.source === source && streams.get(path) === stream

  const setConnected = (connected: boolean) => {
    stream.connected = connected
    if (connected)
      stream.hasConnectedOnce = true
    notify(stream.connectionSubscribers, connected, stream.hasConnectedOnce)
  }

  // Restarted by everything jack sends, including the pings, and by the open.
  const expectMore = () => {
    clearTimeout(stream.silenceTimer)
    stream.silenceTimer = setTimeout(() => {
      stream.silenceTimer = undefined
      if (!isCurrent())
        return
      clearTimeout(stream.reopenTimer)
      stream.reopenTimer = undefined
      source.close()
      setConnected(false)
      connect(path, stream, checkAuthorization)
    }, STREAM_SILENCE_MS)
  }
  expectMore()

  source.onopen = () => {
    if (!isCurrent())
      return
    expectMore()
    setConnected(true)
    notify(stream.openSubscribers)
  }
  source.addEventListener('ping', () => {
    if (isCurrent())
      expectMore()
  })
  source.onmessage = (event) => {
    if (!isCurrent())
      return
    expectMore()
    let snapshot: unknown
    try {
      snapshot = JSON.parse(event.data) as unknown
    }
    catch {
      return
    }
    notify(stream.snapshotSubscribers, snapshot)
  }
  source.onerror = () => {
    if (!isCurrent())
      return
    setConnected(false)
    verifyAuthorization(checkAuthorization)
    // A dropped connection retries by itself, but an HTTP error response (the BFF's
    // 503 while jack restarts) closes the EventSource for good. Reopen it ourselves,
    // or the page would stay on stale data until a reload.
    if (source.readyState === EventSource.CLOSED && stream.reopenTimer === undefined) {
      stream.reopenTimer = setTimeout(() => {
        stream.reopenTimer = undefined
        if (isCurrent())
          connect(path, stream, checkAuthorization)
      }, REOPEN_DELAY_MS)
    }
  }
}

function openStream(path: string, checkAuthorization: AuthorizationCheck): SharedManagementStream {
  const existing = streams.get(path)
  if (existing)
    return existing

  const stream: SharedManagementStream = {
    source: undefined,
    connected: false,
    hasConnectedOnce: false,
    reopenTimer: undefined,
    silenceTimer: undefined,
    snapshotSubscribers: new Set(),
    connectionSubscribers: new Set(),
    openSubscribers: new Set(),
  }
  streams.set(path, stream)
  connect(path, stream, checkAuthorization)
  return stream
}

function closeStream(path: string, stream: SharedManagementStream) {
  clearTimeout(stream.reopenTimer)
  stream.reopenTimer = undefined
  clearTimeout(stream.silenceTimer)
  stream.silenceTimer = undefined
  stream.source?.close()
  stream.source = undefined
  streams.delete(path)
}

export interface ManagementStreamHandlers<T> {
  onSnapshot: (snapshot: T) => void
  // Called right away with the current state, then on every change.
  onConnection?: ConnectionSubscriber
  // Called on every open, the first and each reopen after a drop, and right away
  // when the connection is already open. A stream only sends what happens from
  // then on, so this is where a page fetches what it missed.
  onOpen?: OpenSubscriber
}

/**
 * Subscribe to a management SSE path outside a component's lifecycle, for app-wide
 * state such as useOverview. Returns the unsubscribe function; the last
 * subscriber to leave closes the connection.
 */
export function subscribeManagementStream<T>(
  path: string,
  handlers: ManagementStreamHandlers<T>,
  checkAuthorization: AuthorizationCheck,
): () => void {
  const stream = openStream(path, checkAuthorization)
  const snapshotSubscriber: SnapshotSubscriber = snapshot => handlers.onSnapshot(snapshot as T)
  const connectionSubscriber: ConnectionSubscriber = (connected, hasConnectedOnce) => handlers.onConnection?.(connected, hasConnectedOnce)
  const openSubscriber: OpenSubscriber = () => handlers.onOpen?.()
  stream.snapshotSubscribers.add(snapshotSubscriber)
  stream.connectionSubscribers.add(connectionSubscriber)
  stream.openSubscribers.add(openSubscriber)
  connectionSubscriber(stream.connected, stream.hasConnectedOnce)
  if (stream.connected)
    openSubscriber()

  let subscribed = true
  return () => {
    if (!subscribed)
      return
    subscribed = false
    stream.snapshotSubscribers.delete(snapshotSubscriber)
    stream.connectionSubscribers.delete(connectionSubscriber)
    stream.openSubscribers.delete(openSubscriber)
    if (stream.snapshotSubscribers.size === 0 && streams.get(path) === stream)
      closeStream(path, stream)
  }
}

/**
 * Share one management SSE connection per path while components are subscribed.
 * `hasConnectedOnce` stays false until the first open, so callers can show a neutral
 * "Connecting…" first and the "Reconnecting…" warning only after a real drop.
 *
 * `path` may change (a filter in the query); the old connection closes and a new
 * one opens. While it is null or empty there is no connection, as when paused.
 * `onOpen` is described in ManagementStreamHandlers.
 */
export function useManagementStream<T>(
  path: MaybeRefOrGetter<string | null | undefined>,
  onSnapshot: (snapshot: T) => void,
  options: { onOpen?: () => void } = {},
) {
  const { request } = useManagement()
  const connected = ref(false)
  const hasConnectedOnce = ref(false)
  let unsubscribe: (() => void) | undefined
  let mounted = false

  function subscribe(current: string | null | undefined) {
    unsubscribe?.()
    unsubscribe = undefined
    connected.value = false
    hasConnectedOnce.value = false
    if (!mounted || !current)
      return
    unsubscribe = subscribeManagementStream<T>(current, {
      onSnapshot,
      onConnection: (isConnected, once) => {
        connected.value = isConnected
        hasConnectedOnce.value = once
      },
      onOpen: options.onOpen,
    }, async () => {
      await request('ping')
    })
  }

  watch(() => toValue(path), subscribe)

  onMounted(() => {
    mounted = true
    subscribe(toValue(path))
  })

  onUnmounted(() => {
    mounted = false
    subscribe(undefined)
  })

  return { connected, hasConnectedOnce }
}
