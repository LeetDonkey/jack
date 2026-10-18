import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from '../errors/AppError'
import { FetchError } from '../errors/FetchError'
import { IncompatiblePeerError } from '../errors/IncompatiblePeerError'

/**
 * Why a call to another jack failed, in terms the UI can explain:
 * - `timeout`: no answer within the timeout.
 * - `dns`: the host name doesn't resolve.
 * - `refused`: nothing accepts connections at that address, or the host is unreachable.
 * - `tls`: the HTTPS certificate was rejected.
 * - `unauthorized`: the friend's jack rejected the key (401).
 * - `forbidden`: the friend's jack refused us (403), for example a ban after failed attempts.
 * - `incompatible`: no handshake route or a version too old to talk to.
 * - `unavailable`: the jack or its proxy answered with a 5xx, or cut the connection.
 * - `unknown`: anything else.
 */
export const PEER_ERROR_CODES = ['timeout', 'dns', 'refused', 'tls', 'unauthorized', 'forbidden', 'incompatible', 'unavailable', 'unknown'] as const
export type PeerErrorCode = typeof PEER_ERROR_CODES[number]

export type HostLookup = (hostname: string) => Promise<unknown>

const LOOKUP_TIMEOUT_MS = 2_000

// Bun's fetch reports a name that doesn't resolve the same way as a refused
// connection (code ConnectionRefused, checked against Bun 1.3.14), so those
// two are told apart by resolving the host again.
const CONNECT_CODES = new Set(['ConnectionRefused', 'ECONNREFUSED', 'FailedToOpenSocket', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'])
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'DNSException'])
const CUT_CODES = new Set(['ECONNRESET', 'ConnectionClosed', 'EPIPE', 'UND_ERR_SOCKET'])
const TLS_CODE = /CERT|SSL|TLS/i
const TLS_MESSAGE = /certificate|\bssl\b|\btls\b/i
const IPV6_BRACKETS = /^\[|\]$/g

async function resolves(hostname: string, lookup: HostLookup): Promise<boolean> {
  if (isIP(hostname.replace(IPV6_BRACKETS, '')))
    return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(reject, LOOKUP_TIMEOUT_MS, new Error('DNS lookup timed out'))
    })
    await Promise.race([lookup(hostname), timeout])
    return true
  }
  catch {
    return false
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * The error and the causes it wraps, outermost first: an interactive add wraps
 * the handshake's error, and an IncompatiblePeerError for a missing /handshake
 * wraps the 404 FetchError. Stops at the first error that isn't an AppError.
 */
function causeChain(error: unknown): unknown[] {
  const chain = [error]
  let current = error
  for (let depth = 0; depth < 5 && current instanceof AppError && !(current instanceof FetchError) && current.cause != null; depth++) {
    current = current.cause
    chain.push(current)
  }
  return chain
}

/** The HTTP status the other jack (or its proxy) answered with, when it answered. */
export function peerErrorStatus(error: unknown): number | null {
  const fetchError = causeChain(error).find(e => e instanceof FetchError)
  return fetchError instanceof FetchError ? fetchError.response.status : null
}

/**
 * Classify a failed call to the peer at `url`. A refused connection costs one
 * DNS lookup of the host, to tell a name that doesn't resolve from a host that
 * doesn't answer.
 */
export async function classifyPeerError(error: unknown, url: string, lookup: HostLookup = dnsLookup): Promise<PeerErrorCode> {
  const chain = causeChain(error)
  if (chain.some(e => e instanceof IncompatiblePeerError))
    return 'incompatible'
  // The innermost error says what went wrong; the wrappers only add context.
  const inner = chain.at(-1)
  if (inner instanceof FetchError) {
    const status = inner.response.status
    if (status === 401)
      return 'unauthorized'
    if (status === 403)
      return 'forbidden'
    // An older jack has no /handshake (see PeerConnector.runInit). A proxy that
    // knows no such host or path answers 404 too; peerErrorStatus keeps the 404.
    if (status === 404)
      return 'incompatible'
    if (status >= 500)
      return 'unavailable'
    return 'unknown'
  }
  if (!(inner instanceof Error))
    return 'unknown'
  if (inner.name === 'TimeoutError' || inner.name === 'AbortError')
    return 'timeout'

  const rawCode = (inner as { code?: unknown }).code
  const code = typeof rawCode === 'string' ? rawCode : ''
  if (DNS_CODES.has(code))
    return 'dns'
  if (CONNECT_CODES.has(code)) {
    let hostname: string
    try {
      hostname = new URL(url).hostname
    }
    catch {
      return 'refused'
    }
    return (await resolves(hostname, lookup)) ? 'refused' : 'dns'
  }
  if (CUT_CODES.has(code))
    return 'unavailable'
  if (TLS_CODE.test(code) || TLS_MESSAGE.test(inner.message))
    return 'tls'
  return 'unknown'
}
