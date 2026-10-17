const CHUNK_BYTES = 256 * 1024

/**
 * Stream a file (or a slice of one) in fixed-size chunks, reading the next chunk
 * only when the consumer pulls. Under the node:http server this gives real
 * backpressure: a stalled peer stops disk reads instead of buffering the file in
 * memory. (Bun.serve drains any ReadableStream eagerly, which is why the public
 * server runs on node:http.)
 *
 * `onChunk` runs before each chunk is handed over, so awaiting a rate limiter in
 * it paces the upload. `onEnd` runs exactly once, on completion, on cancellation
 * (peer disconnected) or on a read error.
 */
export function createFileStream(
  file: { size: number, slice: (start: number, end: number) => Blob },
  hooks: { onChunk?: (bytes: number) => void | Promise<void>, onEnd?: () => void, signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  let offset = 0
  let ended = false
  const end = () => {
    if (ended)
      return
    ended = true
    hooks.onEnd?.()
  }

  return new ReadableStream<Uint8Array>({
    // An abort (the peer disconnected) ends the transfer at once: under node:http in
    // Bun the body is neither cancelled nor stops being pulled when the client goes away.
    start(controller) {
      hooks.signal?.addEventListener('abort', () => {
        end()
        try {
          controller.error(hooks.signal!.reason)
        }
        catch {}
      }, { once: true })
    },
    async pull(controller) {
      try {
        if (offset >= file.size) {
          end()
          controller.close()
          return
        }
        const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
        offset += chunk.byteLength
        await hooks.onChunk?.(chunk.byteLength)
        hooks.signal?.throwIfAborted()
        controller.enqueue(chunk)
      }
      catch (err) {
        end()
        controller.error(err)
      }
    },
    cancel() {
      end()
    },
  }, { highWaterMark: 0 })
}
