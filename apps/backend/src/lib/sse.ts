import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

const HEARTBEAT_INTERVAL_MS = 15_000
const MAX_PENDING_WRITES = 16

type Unsubscribe = () => void

// How to end each open stream, for endOpenStreams.
const openStreams = new Set<() => void>()

/**
 * Register how to end an open stream. Returns the function that unregisters it,
 * which the stream calls when it closes.
 */
export function trackStream(end: () => void): Unsubscribe {
  openStreams.add(end)
  return () => openStreams.delete(end)
}

/**
 * End every open stream as a finished response. Called on shutdown: a stream
 * cut by the exit leaves a proxy in front (jack-ui) waiting, while a finished
 * one makes it reconnect.
 */
export function endOpenStreams(): void {
  for (const end of [...openStreams])
    end()
}

/**
 * Stream an initial snapshot and every subsequent change immediately. Writes are
 * serialized only for stream backpressure; there is no batching or drain interval.
 */
export function streamSnapshots<T>(
  c: Context,
  snapshot: () => T,
  subscribe: (subscriber: () => void) => Unsubscribe,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
) {
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    let closed = false
    let pendingWrites = 0
    let writes = Promise.resolve()
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let resolveAbort: (() => void) | undefined
    let unsubscribe: Unsubscribe = () => {}
    let untrack: Unsubscribe = () => {}

    const cleanup = () => {
      if (closed)
        return
      closed = true
      if (heartbeatTimer)
        clearInterval(heartbeatTimer)
      unsubscribe()
      untrack()
      resolveAbort?.()
    }
    untrack = trackStream(cleanup)

    const enqueue = (write: () => Promise<void>) => {
      if (closed || stream.aborted)
        return
      if (pendingWrites >= MAX_PENDING_WRITES) {
        stream.abort()
        cleanup()
        return
      }
      pendingWrites++
      writes = writes
        .then(async () => {
          if (!closed && !stream.aborted)
            await write()
        })
        .catch(cleanup)
        .finally(() => pendingWrites--)
    }

    const sendSnapshot = () => {
      const data = JSON.stringify(snapshot())
      enqueue(() => stream.writeSSE({ data }))
    }

    heartbeatTimer = setInterval(() => {
      enqueue(() => stream.writeSSE({ event: 'ping', data: '' }))
    }, heartbeatIntervalMs)

    unsubscribe = subscribe(sendSnapshot)
    stream.onAbort(cleanup)

    try {
      // Force Bun to commit the response headers before the first SSE frame.
      await stream.write(': open\n\n')
      sendSnapshot()

      await new Promise<void>((resolve) => {
        resolveAbort = resolve
        if (closed || stream.aborted)
          resolve()
      })
      await writes.catch(() => {})
    }
    finally {
      cleanup()
    }
  })
}
