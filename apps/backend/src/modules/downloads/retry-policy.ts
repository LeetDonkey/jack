import { FetchError } from '../../lib/errors/FetchError'
import { IdleTimeoutError } from '../../lib/errors/IdleTimeoutError'
import { IncompleteDownloadError } from '../../lib/errors/IncompleteDownloadError'
import { PeerFileMissingError } from '../../lib/errors/PeerFileMissingError'
import { PieceMismatchError } from '../../lib/errors/PieceMismatchError'
import { CONNECT_CODES, CUT_CODES, DNS_CODES } from '../../lib/net/peer-errors'

// Socket-level failures. Bun rejects a body read whose connection drops
// mid-stream with a plain Error carrying `code: 'ECONNRESET'` ("The socket
// connection was closed unexpectedly"), not a TypeError. Bun's own fetch codes
// are listed alongside the errno names: for a host name that doesn't resolve,
// such as a friend's stopped container, Bun 1.3 answers ConnectionRefused or
// FailedToOpenSocket. The friend status check sorts the same codes.
const TRANSIENT_NETWORK_CODES = new Set([
  ...CONNECT_CODES,
  ...DNS_CODES,
  ...CUT_CODES,
  'ECONNABORTED',
  'ETIMEDOUT',
])

/**
 * Transient = worth retrying: network failures, timeouts, HTTP 5xx, 429, and a
 * truncated stream (the .part is preserved, so a retry resumes). Non-429 4xx and
 * any other error (unsafe filename, file-too-large) are permanent (not retried).
 */
export function isTransientDownloadError(error: unknown): boolean {
  if (error instanceof IncompleteDownloadError)
    return true
  // A piece no peer could repair: the next attempt checks the .part again.
  if (error instanceof PieceMismatchError)
    return true
  if (error instanceof PeerFileMissingError)
    return true
  if (error instanceof IdleTimeoutError)
    return true
  if (error instanceof FetchError) {
    const status = error.response?.status ?? error.extras.status
    if (status == null)
      return true
    if (status === 429)
      return true
    return status >= 500 && status <= 599
  }
  if (error instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError; manual aborts are permanent.
    if (error.name === 'TimeoutError')
      return true
    // A failed fetch (DNS, connection refused, reset) rejects with a TypeError.
    if (error instanceof TypeError)
      return true
    const code = (error as Error & { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code))
      return true
  }
  return false
}

/** Milliseconds to wait per a 429 `Retry-After` header (seconds or HTTP-date), or null. */
// A file missing at the peer is usually back once its *arr finishes a move or
// upgrade; asking every few seconds would only hammer it.
const FILE_MISSING_RETRY_MS = 15 * 60_000

export function downloadRetryAfterMs(error: unknown): number | null {
  if (error instanceof PeerFileMissingError)
    return FILE_MISSING_RETRY_MS
  if (!(error instanceof FetchError))
    return null
  const header = error.response?.headers?.get('Retry-After')
  if (!header)
    return null
  const seconds = Number(header)
  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs))
    return Math.max(0, dateMs - Date.now())
  return null
}
