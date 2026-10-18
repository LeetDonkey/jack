import type { HostLookup, PeerErrorCode } from '../../lib/net/peer-errors'
import { classifyPeerError } from '../../lib/net/peer-errors'

export const EXTERNAL_CHECK_TIMEOUT_MS = 10_000

/** What `POST /config/jack/external/test` answers. */
export interface ExternalCheckResult {
  /** jack answered its /ping through this address. */
  ok: boolean
  /** The HTTP status the address answered with; null when nothing answered. */
  status: number | null
  /** What went wrong, in plain words; null when `ok`. */
  error: string | null
  /** The URL that was fetched. */
  url: string
}

export interface ExternalCheckOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
  /** Host lookup for telling a name that doesn't resolve from a refused connection. */
  lookup?: HostLookup
}

function networkMessage(code: PeerErrorCode, timeoutMs: number, message: string): string {
  switch (code) {
    case 'timeout':
      return `No answer within ${Math.round(timeoutMs / 1000)} seconds.`
    case 'dns':
      return 'The host name doesn\'t resolve from this server.'
    case 'refused':
      return 'Nothing accepts connections at that address, or the host can\'t be reached from this server.'
    case 'tls':
      return `The HTTPS certificate was rejected: ${message}`
    case 'unavailable':
      return 'The connection was cut before an answer arrived.'
    default:
      return message
  }
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403)
    return `The address answered ${status}. A proxy in front of jack may want headers that aren't set here, or it blocks this server.`
  if (status === 404)
    return 'The address answered 404: nothing serves jack\'s /ping there. Check that it points to jack\'s port 5225.'
  if (status >= 500)
    return `The address answered ${status}. A proxy answers, but it may not reach jack.`
  return `The address answered ${status}.`
}

async function answersAsJack(response: Response): Promise<boolean> {
  try {
    const body = await response.json() as { status?: unknown }
    return body?.status === 'OK'
  }
  catch {
    return false
  }
}

/**
 * Fetch `<url>/ping` the way a friend's jack reaches this one (same path rules
 * as a peer connector, the external headers sent along). It shows that this
 * server can reach jack at the address; a friend outside the network may still
 * be blocked (NAT loopback, split DNS, a firewall).
 */
export async function checkExternalUrl(external: { url: string, headers?: Record<string, string> }, options: ExternalCheckOptions = {}): Promise<ExternalCheckResult> {
  const timeoutMs = options.timeoutMs ?? EXTERNAL_CHECK_TIMEOUT_MS
  const url = new URL('/ping', external.url).toString()
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      headers: external.headers ?? {},
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (err) {
    const code = await classifyPeerError(err, url, options.lookup).catch(() => 'unknown' as const)
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, error: networkMessage(code, timeoutMs, message), url }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return { ok: false, status: response.status, error: statusMessage(response.status), url }
  }
  if (!(await answersAsJack(response)))
    return { ok: false, status: response.status, error: 'The address answers, but not as jack. Check that it points to jack\'s port 5225.', url }
  return { ok: true, status: response.status, error: null, url }
}
