import { createMiddleware } from 'hono/factory'
import { clientIp, FORWARDING_HEADERS, inRanges, normalizeIp, PRIVATE_RANGES, realIpHeader } from '../../lib/net/ip'
import { logger } from '../../logger'

declare module 'hono' {
  interface ContextVariableMap {
    /** Set when lanGuard refused the request: a policy answer, not a failed login, so banGuard doesn't count it. */
    lanRefused: boolean
  }
}

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } }
}

export interface ArrAccess {
  /** Refuse the Radarr/Sonarr APIs to addresses outside the LAN and `alsoAllowed`. */
  lanOnly: boolean
  /** Addresses allowed on top of the LAN and loopback. */
  alsoAllowed: readonly string[] | null | undefined
  trustedProxies: readonly string[] | null | undefined
}

const warned = new Set<string>()

/**
 * Keep the Torznab and qBittorrent APIs, which only your own Radarr/Sonarr use,
 * off the internet: a request from outside the LAN and `alsoAllowed` gets 403
 * before any key is checked. Behind a trusted reverse proxy both the client
 * address (see clientIp) and the proxy's X-Real-IP must be allowed, so a client
 * that forges either header is still refused. A request that carries forwarding
 * headers from a peer outside `trustedProxies` is refused too: it is a proxy
 * jack doesn't trust, and its own LAN address would otherwise pass. A request
 * with no socket address (in-process, as in tests) is let through: every request
 * over the network has one.
 */
export function lanGuard(access: () => ArrAccess) {
  return createMiddleware(async (c, next) => {
    const { lanOnly, alsoAllowed, trustedProxies } = access()
    if (!lanOnly)
      return next()
    const remote = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress
    if (!remote)
      return next()
    const headers = c.req.raw.headers
    const proxies = trustedProxies ?? PRIVATE_RANGES
    const allowed = [...PRIVATE_RANGES, ...(alsoAllowed ?? [])]
    const viaProxy = inRanges(normalizeIp(remote), proxies)
    const forwarded = FORWARDING_HEADERS.some(h => headers.has(h))
    const ip = clientIp(remote, headers, proxies)
    const realIp = viaProxy ? realIpHeader(headers) : null
    const ok = (viaProxy || !forwarded)
      && ip != null && inRanges(ip, allowed)
      && (realIp == null || inRanges(realIp, allowed))
    if (ok)
      return next()
    const shown = ip ?? normalizeIp(remote)
    if (!warned.has(shown)) {
      // Scanners bring endless addresses; the first warnings are what matter.
      if (warned.size >= 1000)
        warned.clear()
      warned.add(shown)
      logger.warn({ ip: shown, path: c.req.path }, 'Refused the Radarr/Sonarr API to an address outside your LAN. If it is your own Radarr or Sonarr, add it under Settings -> Security -> Also allow.')
    }
    c.set('lanRefused', true)
    return c.json({ error: 'Not available from this address' }, 403)
  })
}
