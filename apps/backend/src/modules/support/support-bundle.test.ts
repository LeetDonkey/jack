import type { SupportBundleDeps } from './support-bundle'
import { describe, expect, test } from 'bun:test'
import { buildSupportBundle, configSecrets, redactForSupport, redactSupportText, SUPPORT_REDACTED, SUPPORT_WEBHOOK_REMOVED } from './support-bundle'

describe('redactSupportText', () => {
  test('removes URL credentials but keeps the host and path', () => {
    expect(redactSupportText('GET https://bob:hunter2@jack.example.com/handshake failed'))
      .toBe('GET https://jack.example.com/handshake failed')
  })

  test('removes webhook URLs whole', () => {
    expect(redactSupportText('POST https://discord.com/api/webhooks/123/AbCdEf-token failed: 404'))
      .toBe(`POST ${SUPPORT_WEBHOOK_REMOVED} failed: 404`)
    expect(redactSupportText('http://homeassistant:8123/api/webhook/jack-secret-id'))
      .toBe(SUPPORT_WEBHOOK_REMOVED)
  })

  test('masks credential query parameters and header values written as text', () => {
    expect(redactSupportText('http://radarr:7878/api?apikey=abc123&t=search')).toBe(`http://radarr:7878/api?apikey=${SUPPORT_REDACTED}&t=search`)
    expect(redactSupportText('headers: {"X-Api-Key":"jack_0123", "Authorization": "Bearer abc.def"}'))
      .toBe(`headers: {"X-Api-Key":"${SUPPORT_REDACTED}", "Authorization": "${SUPPORT_REDACTED}"}`)
  })

  test('masks anything shaped like a key, and every known secret wherever it appears', () => {
    const arrKey = '0123456789abcdef0123456789abcdef'
    const jackKey = `jack_${'a1'.repeat(32)}`
    expect(redactSupportText(`key ${arrKey} and ${jackKey}`)).toBe(`key ${SUPPORT_REDACTED} and ${SUPPORT_REDACTED}`)
    expect(redactSupportText('token=letmein-please sent to Alice', ['letmein-please'])).toBe(`token=${SUPPORT_REDACTED} sent to Alice`)
    expect(redactSupportText('the proxy secret Sup3rS3cret leaked', ['Sup3rS3cret'])).toBe(`the proxy secret ${SUPPORT_REDACTED} leaked`)
  })
})

describe('redactForSupport', () => {
  test('replaces values under credential keys and scrubs every string', () => {
    const value = {
      name: 'Radarr',
      apiKey: 'whatever',
      headers: { 'CF-Access-Client-Secret': 'x' },
      nested: [{ token: 't', message: 'from https://u:p@host/x' }],
      webhooks: [{ url: 'https://ntfy.sh/my-topic' }],
      count: 3,
    }
    expect(redactForSupport(value) as unknown).toEqual({
      name: 'Radarr',
      apiKey: SUPPORT_REDACTED,
      headers: SUPPORT_REDACTED,
      nested: [{ token: SUPPORT_REDACTED, message: 'from https://host/x' }],
      webhooks: SUPPORT_REDACTED,
      count: 3,
    })
  })
})

describe('configSecrets', () => {
  test('collects keys, header values and webhook URLs, resolving env references', () => {
    const raw = {
      jack: { internalUrl: 'http://jack:5225', tmdbApiKey: { env: 'TMDB' }, external: { url: 'https://me.example', headers: { 'X-Gate': 'gate-secret' } } },
      servers: [{ name: 'Radarr', apiKey: '0123456789abcdef0123456789abcdef', headers: {} }],
      peers: [{ name: 'Alice', apiKey: 'jack_alicekey', headers: { Authorization: { env: 'MISSING' } } }],
      notifications: { webhooks: [{ type: 'ntfy', url: 'https://ntfy.sh/private-topic' }] },
    }
    expect(configSecrets(raw, { TMDB: 'tmdb-key-value' }).sort()).toEqual([
      '0123456789abcdef0123456789abcdef',
      'gate-secret',
      'https://ntfy.sh/private-topic',
      'jack_alicekey',
      'tmdb-key-value',
    ])
  })
})

describe('buildSupportBundle', () => {
  const secrets = ['mgmt-secret-key', 'jack_alicekey', 'https://ntfy.sh/private-topic', 'gate-secret']
  const deps: SupportBundleDeps = {
    version: () => ({ version: '0.1.0', revision: '4ca4a2a1b2c3', buildDate: '2026-10-17T08:30:00.000Z' }),
    internalUrl: () => 'http://user:pw@jack:5225/base',
    externalConfigured: () => true,
    downloads: () => ({ configured: true, active: false }),
    restartPending: () => ['downloads'],
    servers: () => [{
      id: 's1',
      name: 'Radarr',
      type: 'radarr',
      canSource: true,
      canDestination: true,
      autoRegister: { enable: true, priority: 1 },
      isInitialized: false,
      initializationError: 'Failed to fetch http://radarr:7878/api/v3/system/status?apikey=0123456789abcdef0123456789abcdef',
    }] as any,
    peers: () => [{ id: 'p1', name: 'Alice', isInitialized: true, peerVersion: '0.1.0' }] as any,
    health: { get: () => ({ online: false, offlineSince: '2026-10-18T10:00:00.000Z', lastSeenAt: null, lastErrorCode: 'unauthorized', lastError: 'Alice answered 401 for jack_alicekey', version: '0.1.0', build: { revision: 'deadbeef', buildDate: null } }) as any },
    apiKeys: { list: () => [{ id: 1, name: 'Alice', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null }] as any },
    keyMeta: { all: () => new Map([[1, { keyId: 1, peerId: 'p1', origin: 'quick-link' as const, lastUsedAt: '2026-10-18T09:00:00.000Z' }]]) },
    logs: async () => [
      { time: Date.parse('2026-10-18T11:00:00Z'), level: 50, message: 'Notification failed', url: 'https://ntfy.sh/private-topic', pid: 1, hostname: 'x' },
      { time: Date.parse('2026-10-18T11:01:00Z'), level: 40, message: 'Request failed', headers: { 'X-Management-Key': 'mgmt-secret-key' }, error: 'proxy wants gate-secret' },
    ],
    secrets: () => secrets,
    now: () => new Date('2026-10-18T12:00:00Z'),
    timeZone: () => 'Europe/Copenhagen',
  }

  test('keeps what helps and leaves out every secret', async () => {
    const bundle = await buildSupportBundle(deps)
    const text = JSON.stringify(bundle)

    for (const secret of [...secrets, '0123456789abcdef0123456789abcdef', 'user:pw'])
      expect(text).not.toContain(secret)

    expect(bundle.jack).toEqual(deps.version())
    expect(bundle.internalUrlHost).toBe('jack:5225')
    expect(bundle.timeZone).toBe('Europe/Copenhagen')
    expect(bundle.downloads).toEqual({ configured: true, active: false })
    expect(bundle.servers[0]).toMatchObject({ name: 'Radarr', type: 'radarr', source: true, destination: true, initialized: false, registration: null })
    expect(bundle.servers[0]!.initializationError).toContain('http://radarr:7878/api/v3/system/status')
    expect(bundle.peers[0]).toMatchObject({ name: 'Alice', online: false, lastErrorCode: 'unauthorized', build: { revision: 'deadbeef' } })
    expect(bundle.keys).toEqual([{ name: 'Alice', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null, lastUsedAt: '2026-10-18T09:00:00.000Z', origin: 'quick-link', linkedToPeer: true }])
    expect(bundle.logs).toEqual([
      { time: '2026-10-18T11:00:00.000Z', level: 'error', message: 'Notification failed', url: SUPPORT_REDACTED },
      { time: '2026-10-18T11:01:00.000Z', level: 'warn', message: 'Request failed', headers: SUPPORT_REDACTED, error: `proxy wants ${SUPPORT_REDACTED}` },
    ])
  })
})
