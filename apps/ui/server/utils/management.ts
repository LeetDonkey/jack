import type { H3Event } from 'h3'
import type { ProbeResult } from './upstream'
import { canSealSession, MISSING_KEY_MESSAGE } from './session-key'
import { probeJack } from './upstream'

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

/**
 * The sealed session that holds the key in cookie mode. Callers check
 * canSealSession first: without a session key that can seal it, there is no
 * session to open.
 */
export function getManagementSession(event: H3Event) {
  const { sessionKey } = useRuntimeConfig(event)
  // iron-webcrypto's own error, "Empty password", says nothing about the template.
  if (!canSealSession(sessionKey))
    throw createError({ statusCode: 500, statusMessage: MISSING_KEY_MESSAGE })
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
  const { managementKey, sessionKey } = useRuntimeConfig(event)
  if (managementKey)
    return { key: managementKey, mode: 'env' }

  // No session key to seal a cookie with, so nobody can have signed in.
  // /api/ping says what to fix.
  if (!canSealSession(sessionKey))
    return { key: null, mode: 'cookie' }

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

/** Probe jack's management API for this request (probeJack in ./upstream). */
export function probeUpstream(event: H3Event, key: string | null): Promise<ProbeResult> {
  return probeJack(upstreamUrl(event, '/ping'), key)
}
