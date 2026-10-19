import type { SecurityConfig } from '../lib/config'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { SecurityConfig as SecuritySchema } from '../lib/config'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'
import { clientIp, inRanges, isAddressOrRange, PRIVATE_RANGES } from '../lib/net/ip'
import { banGuard } from '../modules/security/ban-guard'
import { BanList } from '../modules/security/ban-list'

const headers = (h: Record<string, string>) => new Headers(h)

describe('client address', () => {
  test('matches IPv4, IPv6 and IPv4-mapped addresses against CIDR ranges', () => {
    expect(inRanges('192.168.0.2', PRIVATE_RANGES)).toBe(true)
    expect(inRanges('::ffff:10.1.2.3', PRIVATE_RANGES)).toBe(true)
    expect(inRanges('172.32.0.1', PRIVATE_RANGES)).toBe(false)
    expect(inRanges('fd12::1', PRIVATE_RANGES)).toBe(true)
    expect(inRanges('2a02:1406::1', PRIVATE_RANGES)).toBe(false)
    expect(inRanges('8.8.8.8', ['8.8.8.8'])).toBe(true)
    expect(inRanges('not-an-ip', PRIVATE_RANGES)).toBe(false)
  })

  test('tells addresses and ranges from other text', () => {
    for (const ok of ['192.168.1.10', '172.18.0.0/16', '0.0.0.0/0', '::1', '[::1]', 'fd00::/8', '2001:db8::/128', '::ffff:10.0.0.1'])
      expect([ok, isAddressOrRange(ok)]).toEqual([ok, true])
    for (const bad of ['', 'Nginx', 'npm', '192.168.1.300', '10.0.0.0/33', '10.0.0.0/', '10.0.0.0/-1', '10.0.0.0/8/8', 'fd00::/129', 'fe80::1%eth0', '10.0.0.0/1e1'])
      expect([bad, isAddressOrRange(bad)]).toEqual([bad, false])
  })

  test('believes forwarding headers only from a trusted proxy', () => {
    const spoof = headers({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '1.1.1.1' })
    expect(clientIp('203.0.113.9', spoof, PRIVATE_RANGES)).toBe('203.0.113.9')
    expect(clientIp('192.168.0.2', headers({ 'x-real-ip': '198.51.100.7' }), PRIVATE_RANGES)).toBe('198.51.100.7')
    // A client-supplied X-Forwarded-For entry is ignored in favour of what the proxy appended.
    expect(clientIp('::ffff:172.18.0.1', headers({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7, 192.168.0.2' }), PRIVATE_RANGES)).toBe('198.51.100.7')
    expect(clientIp('192.168.0.2', headers({}), PRIVATE_RANGES)).toBe('192.168.0.2')
    expect(clientIp(undefined, headers({}), PRIVATE_RANGES)).toBeNull()
  })
})

function banList(overrides: Partial<SecurityConfig> = {}, sqlite = new Database(':memory:')) {
  let now = Date.parse('2026-10-17T12:00:00Z')
  const config = { ...SecuritySchema.parse({ banEnabled: true, maxFailures: 3, windowMinutes: 10, banMinutes: 60 }), ...overrides }
  const bans = new BanList(sqlite, () => config, () => new Date(now))
  const clock = () => new Date(now)
  const advance = (minutes: number) => {
    now += minutes * 60_000
  }
  return { bans, sqlite, config, clock, advance }
}

describe('BanList', () => {
  test('bans after maxFailures inside the window, and only then', () => {
    const { bans, advance } = banList()
    expect(bans.recordFailure('203.0.113.9', 'x')).toBeNull()
    advance(11) // the first failure falls out of the window
    expect(bans.recordFailure('203.0.113.9', 'x')).toBeNull()
    expect(bans.recordFailure('203.0.113.9', 'x')).toBeNull()
    expect(bans.failing()).toMatchObject([{ ip: '203.0.113.9', failures: 2 }])
    expect(bans.recordFailure('203.0.113.9', 'GET /peer/search -> 401')).toMatchObject({ ip: '203.0.113.9', failures: 3, reason: 'GET /peer/search -> 401' })
    expect(bans.activeBan('203.0.113.9')).not.toBeNull()
    expect(bans.failing()).toEqual([])
  })

  test('a ban expires, survives a restart and can be lifted', () => {
    const { bans, sqlite, config, clock, advance } = banList()
    for (let i = 0; i < 3; i++)
      bans.recordFailure('203.0.113.9', 'x')
    const restarted = new BanList(sqlite, () => config, clock)
    expect(restarted.list().map(b => b.ip)).toEqual(['203.0.113.9'])
    expect(bans.unban('203.0.113.9')).toBe(true)
    expect(bans.activeBan('203.0.113.9')).toBeNull()

    for (let i = 0; i < 3; i++)
      bans.recordFailure('203.0.113.9', 'x')
    advance(61)
    expect(bans.activeBan('203.0.113.9')).toBeNull()
    expect(bans.list()).toEqual([])
  })

  test('never counts the LAN, and counts nothing while switched off', () => {
    const { bans } = banList()
    for (let i = 0; i < 10; i++)
      bans.recordFailure('192.168.0.20', 'x')
    expect(bans.activeBan('192.168.0.20')).toBeNull()

    const off = banList({ banEnabled: false }).bans
    for (let i = 0; i < 10; i++)
      off.recordFailure('203.0.113.9', 'x')
    expect(off.activeBan('203.0.113.9')).toBeNull()
  })

  test('neverBan adds to the LAN instead of replacing it', () => {
    const { bans } = banList({ neverBan: ['100.64.0.0/10'] })
    for (let i = 0; i < 10; i++) {
      bans.recordFailure('192.168.0.20', 'x')
      bans.recordFailure('127.0.0.1', 'x')
      bans.recordFailure('100.101.102.103', 'x')
    }
    expect(bans.list()).toEqual([])
    expect(bans.exempt('203.0.113.9')).toBe(false)
  })
})

describe('banGuard', () => {
  // A public-app stand-in: a route that rejects without a key, the qBittorrent login, and /ping.
  function app(bans: BanList) {
    const hono = new Hono()
    hono.onError((err, c) => c.json({ error: err.message }, err instanceof UnauthorizedError ? 401 : 500))
    hono.use('*', banGuard(bans, () => undefined))
    hono.get('/ping', c => c.json({ status: 'OK' }))
    hono.get('/peer/search', (c) => {
      if (c.req.header('x-api-key') !== 'good')
        throw new UnauthorizedError('invalid API key')
      return c.json({ items: [] })
    })
    hono.post('/api/v2/auth/login', c => c.text('Fails.', 200))
    return hono
  }
  // Requests arrive through NPMplus (a trusted private address) carrying the real client in X-Real-IP.
  const via = (client: string) => [{ headers: { 'x-real-ip': client } }, { incoming: { socket: { remoteAddress: '192.168.0.2' } } }] as const

  test('counts rejected keys and failed qBittorrent logins, then refuses the address everywhere', async () => {
    const { bans } = banList()
    const hono = app(bans)
    const [init, env] = via('203.0.113.9')
    expect((await hono.request('/peer/search', init, env)).status).toBe(401)
    expect((await hono.request('/api/v2/auth/login', { ...init, method: 'POST' }, env)).status).toBe(200)
    expect((await hono.request('/peer/search', init, env)).status).toBe(401)

    const refused = await hono.request('/ping', init, env)
    expect(refused.status).toBe(403)
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(3500)
    // Another client is unaffected, and so is a request with the right key from it.
    const [other, otherEnv] = via('198.51.100.7')
    expect((await hono.request('/peer/search', { headers: { ...other.headers, 'x-api-key': 'good' } }, otherEnv)).status).toBe(200)
  })

  test('a client-supplied X-Real-IP from an untrusted peer does not let it dodge or frame', async () => {
    const { bans } = banList()
    const hono = app(bans)
    const env = { incoming: { socket: { remoteAddress: '203.0.113.9' } } }
    for (const spoofed of ['1.1.1.1', '2.2.2.2', '3.3.3.3'])
      await hono.request('/peer/search', { headers: { 'x-real-ip': spoofed } }, env)
    expect(bans.list().map(b => b.ip)).toEqual(['203.0.113.9'])
  })
})
