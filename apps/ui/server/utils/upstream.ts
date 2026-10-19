import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// How jack-ui talks to jack's management API: the probe behind /api/ping and the
// connection screen, and the proxy's guard against calls that never get an
// answer. Free of h3 and runtimeConfig, so the tests call it directly.

/** Why jack-ui can't reach jack's management API. */
export type ProbeFailure = 'dns' | 'down' | 'timeout'

export type ProbeResult = { reachable: true, status: number } | { reachable: false, reason: ProbeFailure }

export const PROBE_TIMEOUT_MS = 5_000

// URL.hostname keeps the brackets around an IPv6 literal.
const IPV6_BRACKETS = /^\[(.*)\]$/

type HostLookup = (hostname: string) => Promise<unknown>

interface BunDns {
  dns?: { lookup?: (hostname: string, options: { backend: 'system' }) => Promise<unknown> }
}

// A lookup that asks the system resolver every time. In a long-running Bun
// process, node:dns `lookup` and `resolve4` answer from a c-ares cache: measured
// on Docker's DNS, they served a vanished container's address for its 600 s TTL,
// and kept failing for minutes after the name was back. Bun's `system` backend
// (getaddrinfo) and fetch saw each change within 2 s. Under Node (nuxt dev),
// node:dns `lookup` is getaddrinfo already.
function systemLookup(): HostLookup {
  const bun = (globalThis as { Bun?: BunDns }).Bun
  if (bun?.dns?.lookup)
    return hostname => bun.dns!.lookup!(hostname, { backend: 'system' })
  return hostname => lookup(hostname)
}

/**
 * Whether `hostname` resolves right now: true, false, or null when the lookup
 * didn't settle before `signal` aborted. An IP literal needs no lookup.
 */
export function hostResolves(hostname: string, signal: AbortSignal, lookupHost: HostLookup = systemLookup()): Promise<boolean | null> {
  const bare = hostname.replace(IPV6_BRACKETS, '$1')
  if (isIP(bare))
    return Promise.resolve(true)
  if (signal.aborted)
    return Promise.resolve(null)
  return new Promise((resolve) => {
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    lookupHost(bare)
      .then(() => resolve(true), () => resolve(false))
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function keyHeaders(key: string | null): Record<string, string> {
  return key ? { 'X-Management-Key': key } : {}
}

// The probe only needs the status line. Dropping the body frees the connection.
function discardBody(res: Response) {
  res.body?.cancel().catch(() => {})
}

export interface ProbeOptions {
  timeoutMs?: number
  dnsGraceMs?: number
  fetch?: typeof fetch
  lookupHost?: HostLookup
}

// How long the request still gets once the lookup says the name is gone. A
// jack that answers does so in milliseconds, while a request to the address
// Bun's fetch still has cached for a stopped jack hangs for the full timeout.
export const DNS_GRACE_MS = 1_000

/**
 * Probe jack's management API at `url` (its /ping), within `timeoutMs` (5 s).
 * jack only starts that API when its Management key is set, so an empty key
 * there shows up as `down`.
 *
 * Any answer means reachable. The lookup runs alongside the request and only
 * explains a failure: Bun's fetch reports a name that doesn't resolve as
 * ConnectionRefused, the same as a closed port. Docker's DNS drops a stopped
 * container's name, so a stopped jack usually shows up as `dns`, after
 * `dnsGraceMs` rather than the full timeout.
 */
export async function probeJack(url: string, key: string | null, options: ProbeOptions = {}): Promise<ProbeResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS)
  const nameGone = new AbortController()
  const resolving = hostResolves(new URL(url).hostname, timeout, options.lookupHost)
  let done = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  void resolving.then((resolves) => {
    if (resolves === false && !done)
      graceTimer = setTimeout(() => nameGone.abort(), options.dnsGraceMs ?? DNS_GRACE_MS)
  })

  try {
    const res = await (options.fetch ?? fetch)(url, { headers: keyHeaders(key), signal: AbortSignal.any([timeout, nameGone.signal]) })
    discardBody(res)
    return { reachable: true, status: res.status }
  }
  catch {
    if (await resolving === false)
      return { reachable: false, reason: 'dns' }
    return { reachable: false, reason: timeout.aborted ? 'timeout' : 'down' }
  }
  finally {
    done = true
    clearTimeout(graceTimer)
  }
}

export const ALIVE_TIMEOUT_MS = 2_500

const aliveChecks = new Map<string, Promise<boolean>>()

/**
 * Whether jack answers at `url` (its /ping) within `timeoutMs`. Any status
 * counts. Calls for the same URL while one is on its way share it, so a page
 * with several slow calls asks once.
 */
export function jackAnswers(url: string, key: string | null, timeoutMs = ALIVE_TIMEOUT_MS, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const running = aliveChecks.get(url)
  if (running)
    return running
  const check = fetchImpl(url, { headers: keyHeaders(key), signal: AbortSignal.timeout(timeoutMs) })
    .then((res) => {
      discardBody(res)
      return true
    }, () => false)
    .finally(() => aliveChecks.delete(url))
  aliveChecks.set(url, check)
  return check
}

/** jack didn't send response headers in time and didn't answer a check either. */
export class JackSilentError extends Error {
  constructor() {
    super('jack isn\'t answering')
    this.name = 'JackSilentError'
  }
}

// jack sends a stream's headers right away, with an `: open` comment
// (lib/sse.ts), so a stream without them after this long is stuck.
export const STREAM_HEADERS_MS = 5_000
// Other calls can take long before jack answers: saving a Radarr/Sonarr waits
// up to 25 s for the registration, and the indexer test, a folder check, a
// friend's catalog or a handshake round can each take 30-45 s. After this long
// without headers the proxy asks /ping, and keeps waiting while jack answers.
export const CHECK_ALIVE_AFTER_MS = 2_500
export const CHECK_ALIVE_EVERY_MS = 5_000

export interface UpstreamFetchOptions {
  // Aborts the call: the browser left. Stays linked to the body after the
  // headers, so it also stops a stream.
  signal: AbortSignal
  // An SSE stream (the browser's EventSource).
  stream: boolean
  // Whether jack answers at all (jackAnswers on its /ping).
  isAlive: () => Promise<boolean>
  streamHeadersMs?: number
  checkAfterMs?: number
  checkEveryMs?: number
  fetch?: typeof fetch
}

/**
 * fetch() for the proxy, which fails with JackSilentError when jack doesn't get
 * as far as response headers. A stopped container's old address takes new
 * connections without an answer or a reset, so a call there otherwise hangs
 * until the connect gives up, 30 s or more. A stream gets `streamHeadersMs`.
 * Any other call is checked `checkAfterMs` in, then every `checkEveryMs`, and
 * fails once jack stops answering /ping. Nothing is timed after the headers.
 */
export async function fetchUpstream(target: string, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> {
  const silent = new AbortController()
  const signal = AbortSignal.any([options.signal, silent.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false

  const giveUp = () => {
    if (!settled)
      silent.abort(new JackSilentError())
  }
  const check = async () => {
    const alive = await options.isAlive().catch(() => false)
    if (settled)
      return
    if (alive)
      timer = setTimeout(check, options.checkEveryMs ?? CHECK_ALIVE_EVERY_MS)
    else
      giveUp()
  }
  timer = options.stream
    ? setTimeout(giveUp, options.streamHeadersMs ?? STREAM_HEADERS_MS)
    : setTimeout(check, options.checkAfterMs ?? CHECK_ALIVE_AFTER_MS)

  try {
    return await (options.fetch ?? fetch)(target, { ...init, signal })
  }
  catch (error) {
    throw silent.signal.aborted ? silent.signal.reason : error
  }
  finally {
    settled = true
    clearTimeout(timer)
  }
}
