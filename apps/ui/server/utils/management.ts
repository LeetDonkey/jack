import type { H3Event } from 'h3'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const SESSION_NAME = 'jack_management'

export type AuthMode = 'env' | 'cookie'

export interface ResolvedKey {
  key: string | null
  mode: AuthMode
}

interface SessionData {
  key?: string
}

// Secure cookie is driven by the forwarded proto so it works behind a reverse
// proxy (Traefik/Cloudflare) terminating TLS in front of the HTTP-only BFF.
function isSecure(event: H3Event): boolean {
  const forwarded = getRequestHeader(event, 'x-forwarded-proto')
  if (forwarded)
    return forwarded.split(',')[0]!.trim() === 'https'
  return getRequestProtocol(event) === 'https'
}

export function getManagementSession(event: H3Event) {
  const { sessionKey } = useRuntimeConfig(event)
  return useSession<SessionData>(event, {
    name: SESSION_NAME,
    // h3's `useSession` calls this option `password`; it's our session secret.
    password: sessionKey,
    cookie: {
      httpOnly: true,
      secure: isSecure(event),
      sameSite: 'strict',
      path: '/',
    },
  })
}

/**
 * Resolve the management key for this request. `env` mode: the BFF injects the
 * key from its own environment (browser never sees it). `cookie` mode: the key
 * comes from the sealed session cookie set at login (null until the user logs in).
 */
export async function resolveKey(event: H3Event): Promise<ResolvedKey> {
  const { managementKey } = useRuntimeConfig(event)
  if (managementKey)
    return { key: managementKey, mode: 'env' }

  const session = await getManagementSession(event)
  return { key: session.data.key ?? null, mode: 'cookie' }
}

export function upstreamUrl(event: H3Event, path: string): string {
  const { managementApiUrl } = useRuntimeConfig(event)
  return new URL(path, managementApiUrl).toString()
}

/**
 * CSRF defense for state-changing requests: the auto-sent cookie is paired with a
 * same-origin check. `SameSite=Strict` already blocks cross-site sends; this is
 * defense-in-depth against any request that does carry an Origin from elsewhere.
 */
export function assertSameOrigin(event: H3Event): void {
  const origin = getRequestHeader(event, 'origin')
  if (!origin)
    return

  const host = getRequestHeader(event, 'host')
  let originHost: string
  try {
    originHost = new URL(origin).host
  }
  catch {
    throw createError({ statusCode: 403, statusMessage: 'invalid origin' })
  }

  if (!host || originHost !== host)
    throw createError({ statusCode: 403, statusMessage: 'cross-origin request rejected' })
}

const PROBE_TIMEOUT_MS = 5000

/** Why jack-ui can't reach jack's management API. */
export type ProbeFailure = 'dns' | 'down' | 'timeout'

export type ProbeResult = { reachable: true, status: number } | { reachable: false, reason: ProbeFailure }

/** The management API's origin as configured, for the "can't reach jack" screen. */
export function upstreamOrigin(event: H3Event): string {
  const { managementApiUrl } = useRuntimeConfig(event)
  try {
    return new URL(managementApiUrl).origin
  }
  catch {
    return managementApiUrl
  }
}

// URL.hostname keeps the brackets around an IPv6 literal.
const IPV6_BRACKETS = /^\[(.*)\]$/

// Resolving the host first tells a name that doesn't resolve apart from a jack
// that resolves but doesn't answer. Docker's DNS drops a container's name while
// it is stopped, so a stopped jack lands here too. IP literals skip the lookup.
function lookupHost(hostname: string, signal: AbortSignal): Promise<unknown> {
  const bare = hostname.replace(IPV6_BRACKETS, '$1')
  if (isIP(bare))
    return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    lookup(bare)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Probe the upstream management API, within 5 s for the lookup and the request
 * together. jack only starts that API when its Management key is set, so an
 * empty key there shows up as `down`.
 */
export async function probeUpstream(event: H3Event, key: string | null): Promise<ProbeResult> {
  const target = upstreamUrl(event, '/ping')
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)

  try {
    await lookupHost(new URL(target).hostname, signal)
  }
  catch {
    return { reachable: false, reason: signal.aborted ? 'timeout' : 'dns' }
  }

  try {
    const res = await fetch(target, {
      headers: key ? { 'X-Management-Key': key } : {},
      signal,
    })
    return { reachable: true, status: res.status }
  }
  catch {
    return { reachable: false, reason: signal.aborted ? 'timeout' : 'down' }
  }
}
