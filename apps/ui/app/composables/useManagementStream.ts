type SnapshotSubscriber = (snapshot: unknown) => void
type ConnectionSubscriber = (connected: boolean) => void
type AuthorizationCheck = () => Promise<void>

// How long to wait before reopening a stream the browser gave up on.
const REOPEN_DELAY_MS = 5_000

interface SharedManagementStream {
  source: EventSource | undefined
  connected: boolean
  // Set by the first successful open and kept through drops, so a badge can tell
  // "still connecting" apart from "lost the connection".
  hasConnectedOnce: boolean
  reopenTimer: ReturnType<typeof setTimeout> | undefined
  snapshotSubscribers: Set<SnapshotSubscriber>
  connectionSubscribers: Set<ConnectionSubscriber>
}

const streams = new Map<string, SharedManagementStream>()
let authorizationCheck: Promise<void> | undefined

function verifyAuthorization(check: AuthorizationCheck) {
  authorizationCheck ??= check()
    .catch(() => {})
    .finally(() => authorizationCheck = undefined)
}

function connect(path: string, stream: SharedManagementStream, checkAuthorization: AuthorizationCheck) {
  const source = new EventSource(`/api/management/${path}`)
  stream.source = source

  const setConnected = (connected: boolean) => {
    stream.connected = connected
    if (connected)
      stream.hasConnectedOnce = true
    for (const subscriber of stream.connectionSubscribers)
      subscriber(connected)
  }

  source.onopen = () => setConnected(true)
  source.onmessage = (event) => {
    let snapshot: unknown
    try {
      snapshot = JSON.parse(event.data) as unknown
    }
    catch {
      return
    }
    for (const subscriber of stream.snapshotSubscribers) {
      try {
        subscriber(snapshot)
      }
      catch {
        // One component must not prevent the others from receiving this frame.
      }
    }
  }
  source.onerror = () => {
    setConnected(false)
    verifyAuthorization(checkAuthorization)
    // A dropped connection retries by itself, but an HTTP error response (the BFF's
    // 503 while jack restarts) closes the EventSource for good. Reopen it ourselves,
    // or the page would stay on stale data until a reload.
    if (source.readyState === EventSource.CLOSED && stream.source === source && stream.reopenTimer === undefined) {
      stream.reopenTimer = setTimeout(() => {
        stream.reopenTimer = undefined
        if (streams.get(path) === stream)
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
    snapshotSubscribers: new Set(),
    connectionSubscribers: new Set(),
  }
  streams.set(path, stream)
  connect(path, stream, checkAuthorization)
  return stream
}

function closeStream(path: string, stream: SharedManagementStream) {
  clearTimeout(stream.reopenTimer)
  stream.reopenTimer = undefined
  stream.source?.close()
  stream.source = undefined
  streams.delete(path)
}

/**
 * Share one management SSE connection per path while components are subscribed.
 * `hasConnectedOnce` stays false until the first open, so callers can show a neutral
 * "Connecting…" first and the "Reconnecting…" warning only after a real drop.
 */
export function useManagementStream<T>(path: string, onSnapshot: (snapshot: T) => void) {
  const { request } = useManagement()
  const connected = ref(false)
  const hasConnectedOnce = ref(false)
  let stream: SharedManagementStream | undefined
  const snapshotSubscriber: SnapshotSubscriber = snapshot => onSnapshot(snapshot as T)
  const connectionSubscriber: ConnectionSubscriber = (value) => {
    connected.value = value
    if (value)
      hasConnectedOnce.value = true
  }

  onMounted(() => {
    stream = openStream(path, async () => {
      await request('ping')
    })
    stream.snapshotSubscribers.add(snapshotSubscriber)
    stream.connectionSubscribers.add(connectionSubscriber)
    connected.value = stream.connected
    hasConnectedOnce.value = stream.hasConnectedOnce
  })

  onUnmounted(() => {
    if (!stream)
      return
    stream.snapshotSubscribers.delete(snapshotSubscriber)
    stream.connectionSubscribers.delete(connectionSubscriber)
    if (stream.snapshotSubscribers.size === 0)
      closeStream(path, stream)
    stream = undefined
    connected.value = false
    hasConnectedOnce.value = false
  })

  return { connected, hasConnectedOnce }
}
