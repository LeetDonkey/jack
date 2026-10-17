import type { BanList } from './ban-list'
import { createMiddleware } from 'hono/factory'
import { clientIp, PRIVATE_RANGES } from '../../lib/net/ip'

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } }
}

/**
 * First middleware on the public app: refuse banned addresses outright, and
 * count failed authentication (401/403 answers and qBittorrent's `Fails.`
 * login) towards a ban.
 */
export function banGuard(bans: BanList, trustedProxies: () => readonly string[] | null | undefined) {
  return createMiddleware(async (c, next) => {
    const remote = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress
    const ip = clientIp(remote, c.req.raw.headers, trustedProxies() ?? PRIVATE_RANGES)
    if (ip) {
      const ban = bans.activeBan(ip)
      if (ban) {
        return c.json({ error: 'Too many failed attempts; try again later' }, 403, { 'Retry-After': String(bans.secondsLeft(ban)) })
      }
    }

    await next()

    if (!ip)
      return
    const status = c.res.status
    let failed = status === 401 || status === 403
    // qBittorrent answers a failed login with 200 `Fails.`.
    if (!failed && status === 200 && c.req.method === 'POST' && c.req.path.endsWith('/api/v2/auth/login'))
      failed = (await c.res.clone().text()) === 'Fails.'
    if (failed)
      bans.recordFailure(ip, `${c.req.method} ${c.req.path} -> ${status === 200 ? 'failed login' : status}`)
  })
}
