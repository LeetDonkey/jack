import type { ArrAccess } from './lan-guard'
import { Database } from 'bun:sqlite'
import { describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { SecurityConfig } from '../../lib/config'
import { clientIp, PRIVATE_RANGES } from '../../lib/net/ip'
import { logger } from '../../logger'
import { banGuard } from './ban-guard'
import { BanList } from './ban-list'
import { lanGuard } from './lan-guard'

function appWith(access: Partial<ArrAccess>, bans?: BanList) {
  const app = new Hono()
  if (bans)
    app.use('*', banGuard(bans, () => access.trustedProxies))
  app.use('/torznab/*', lanGuard(() => ({ lanOnly: true, alsoAllowed: null, trustedProxies: null, ...access })))
  app.get('/torznab/api', c => c.text('ok'))
  app.get('/peer/search', c => c.json({ error: 'invalid API key' }, 401))
  return app
}

const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })
const headers = (h: Record<string, string>) => new Headers(h)

describe('lanGuard', () => {
  it('lets the LAN and loopback through by default', async () => {
    const app = appWith({})
    for (const ip of ['192.168.0.20', '10.1.2.3', '172.17.0.5', '127.0.0.1', '::ffff:192.168.1.9'])
      expect((await app.request('/torznab/api', {}, from(ip))).status).toBe(200)
  })

  it('refuses an internet address with 403', async () => {
    const res = await appWith({}).request('/torznab/api', {}, from('203.0.113.9'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Not available from this address' })
  })

  it('refuses an internet client behind the trusted reverse proxy', async () => {
    const res = await appWith({}).request('/torznab/api', { headers: { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.7' } }, from('192.168.0.2'))
    expect(res.status).toBe(403)
  })

  it('lets a LAN client through the proxy', async () => {
    const res = await appWith({}).request('/torznab/api', { headers: { 'x-real-ip': '192.168.0.30', 'x-forwarded-for': '192.168.0.30' } }, from('192.168.0.2'))
    expect(res.status).toBe(200)
  })

  it('refuses a forged X-Real-IP passed through by a proxy that only appends X-Forwarded-For', async () => {
    // Caddy, Go's ReverseProxy and HAProxy forward a client's own X-Real-IP untouched.
    const res = await appWith({}).request('/torznab/api', { headers: { 'x-real-ip': '192.168.0.9', 'x-forwarded-for': '203.0.113.9' } }, from('172.18.0.5'))
    expect(res.status).toBe(403)
  })

  it('refuses a forged X-Forwarded-For passed through by a proxy that only sets X-Real-IP', async () => {
    const res = await appWith({}).request('/torznab/api', { headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '192.168.0.9' } }, from('172.18.0.5'))
    expect(res.status).toBe(403)
  })

  it('refuses forwarded requests from a proxy outside trustedProxies instead of passing its LAN address', async () => {
    const app = appWith({ trustedProxies: ['172.18.0.0/16'] })
    expect((await app.request('/torznab/api', { headers: { 'x-real-ip': '198.51.100.7' } }, from('192.168.0.2'))).status).toBe(403)
    expect((await appWith({ trustedProxies: [] }).request('/torznab/api', { headers: { 'x-forwarded-for': '198.51.100.7' } }, from('192.168.0.2'))).status).toBe(403)
    // A Radarr connecting directly sends no forwarding headers.
    expect((await appWith({ trustedProxies: [] }).request('/torznab/api', {}, from('192.168.0.20'))).status).toBe(200)
  })

  it('also allows the listed addresses, on top of the LAN', async () => {
    const app = appWith({ alsoAllowed: ['100.64.0.0/10'] })
    expect((await app.request('/torznab/api', {}, from('100.101.102.103'))).status).toBe(200)
    expect((await app.request('/torznab/api', {}, from('192.168.0.20'))).status).toBe(200)
    expect((await app.request('/torznab/api', {}, from('203.0.113.9'))).status).toBe(403)
  })

  it('logs a refused address once, naming the field in Settings that lets it in', async () => {
    const warn = spyOn(logger, 'warn')
    try {
      const app = appWith({})
      for (let i = 0; i < 2; i++)
        expect((await app.request('/torznab/api', {}, from('198.51.100.201'))).status).toBe(403)
      const lines = warn.mock.calls.filter(([fields]) => (fields as { ip?: string }).ip === '198.51.100.201')
      expect(lines).toHaveLength(1)
      expect(lines[0]?.[1]).toEndWith('add it under Settings -> Sharing -> Security -> Reverse proxy and exceptions -> Radarr/Sonarr outside your LAN.')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('lets everyone through when switched off', async () => {
    const res = await appWith({ lanOnly: false }).request('/torznab/api', {}, from('203.0.113.9'))
    expect(res.status).toBe(200)
  })

  it('lets an in-process request without a socket through', async () => {
    expect((await appWith({}).request('/torznab/api')).status).toBe(200)
  })

  it('does not count its refusals towards a ban, while wrong keys still do', async () => {
    const bans = new BanList(new Database(':memory:'), () => SecurityConfig.parse({ banEnabled: true, maxFailures: 3 }))
    const app = appWith({}, bans)
    for (let i = 0; i < 5; i++)
      expect((await app.request('/torznab/api', {}, from('100.101.102.103'))).status).toBe(403)
    expect(bans.activeBan('100.101.102.103')).toBeNull()
    for (let i = 0; i < 3; i++)
      await app.request('/peer/search', {}, from('100.101.102.103'))
    expect(bans.activeBan('100.101.102.103')).not.toBeNull()
  })
})

describe('clientIp', () => {
  it('prefers the rightmost untrusted X-Forwarded-For entry over X-Real-IP', () => {
    expect(clientIp('172.18.0.5', headers({ 'x-real-ip': '192.168.0.9', 'x-forwarded-for': '203.0.113.9' }), PRIVATE_RANGES)).toBe('203.0.113.9')
    expect(clientIp('172.18.0.5', headers({ 'x-forwarded-for': '198.51.100.77, 203.0.113.9' }), PRIVATE_RANGES)).toBe('203.0.113.9')
  })

  it('falls back to X-Real-IP, as NPM sends it alone', () => {
    expect(clientIp('192.168.0.2', headers({ 'x-real-ip': '198.51.100.7' }), PRIVATE_RANGES)).toBe('198.51.100.7')
  })
})
