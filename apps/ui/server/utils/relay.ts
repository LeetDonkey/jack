import type { IncomingMessage, ServerResponse } from 'node:http'

interface SocketState {
  destroyed?: boolean
  readyState?: string
}

function connectionClosed(req: IncomingMessage): boolean {
  const socket = req.socket as SocketState | null | undefined
  return socket?.destroyed === true || socket?.readyState === 'closed'
}

/**
 * Calls `onGone` once when the browser disconnects before the response has
 * finished. Returns the function that stops listening.
 *
 * Node reports this as the response's 'close' before it finished. Bun's
 * node:http, which runs jack-ui, never does: writes keep succeeding and the
 * response closes only once it has ended. There the request's 'aborted' and
 * 'close' events are the only sign. 'close' also fires once a request body has
 * been read, so it counts only when the connection is closed.
 *
 * Those events fire once. A browser that left while the handler awaited
 * something before this call (the session unseal in cookie mode) is past them,
 * so a connection that is closed already calls `onGone` right away, before this
 * returns. `req.destroyed` is no sign: Bun sets it once a request body has been
 * read, with the browser still waiting for the answer.
 */
export function onClientGone(req: IncomingMessage, res: ServerResponse, onGone: () => void): () => void {
  let done = false
  const stop = () => {
    done = true
    res.off('close', fire)
    req.off('aborted', fire)
    req.off('close', onRequestClose)
  }
  function fire() {
    if (done || res.writableFinished)
      return
    stop()
    onGone()
  }
  function onRequestClose() {
    if (connectionClosed(req))
      fire()
  }
  res.on('close', fire)
  req.on('aborted', fire)
  req.on('close', onRequestClose)
  // The browser may have left already.
  onRequestClose()
  return stop
}

function drained(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
    signal.addEventListener('abort', done)
  })
}

/**
 * Copies jack's response body to the browser and settles once the response is
 * over. Returns true when jack finished the body.
 *
 * A body jack cuts off (it restarted mid-stream) destroys the response, so the
 * browser sees the connection drop: an EventSource reconnects instead of waiting
 * on a stream that will never send again, and a fetch fails instead of reading
 * half a JSON document. Aborting `upstream` (the browser left) stops the copy.
 */
export async function relayBody(body: ReadableStream<Uint8Array> | null, res: ServerResponse, upstream: AbortSignal): Promise<boolean> {
  if (!body) {
    res.end()
    return true
  }

  const reader = body.getReader()
  const cancel = () => {
    reader.cancel().catch(() => {})
  }
  upstream.addEventListener('abort', cancel, { once: true })

  let complete = false
  try {
    while (!upstream.aborted) {
      const { done, value } = await reader.read()
      if (done) {
        complete = !upstream.aborted
        break
      }
      if (!res.write(value))
        await drained(res, upstream)
    }
  }
  catch {
    // jack dropped the connection mid-body, or the read was cancelled.
  }
  finally {
    upstream.removeEventListener('abort', cancel)
  }

  if (complete)
    res.end()
  else if (!res.destroyed)
    res.destroy()
  return complete
}
