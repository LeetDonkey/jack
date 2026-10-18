import { describe, expect, test } from 'bun:test'
import { getApp } from '../app'
import { AppConfig, MIGRATIONS, SecurityConfig } from '../lib/config'
import { PROTOCOL_VERSION } from '../lib/version'
import { makeAuthRepos } from './helpers/auth-repos'

const envs = { ENVIRONMENT: 'test', ENABLE_LOGS: false, LOG_LEVEL: 'fatal' } as any

function buildApp() {
  const config = AppConfig.parse({
    version: MIGRATIONS.length,
    jack: { internalUrl: 'http://jack:5225', apiKey: 'test-api-key' },
    servers: [],
    peers: [],
  })
  return getApp(envs, config, { servers: [], peers: [] }, { ...makeAuthRepos() })
}

describe('GET /handshake', () => {
  test('returns the server identity and version with a valid api key', async () => {
    const res = await buildApp().request('/handshake?apikey=test-api-key')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'jack', version: PROTOCOL_VERSION })
  })

  test('rejects a request without an api key', async () => {
    const res = await buildApp().request('/handshake')
    expect(res.status).toBe(401)
  })
})

describe('public port defaults', () => {
  const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })
  function secureApp(security: Record<string, unknown> = {}) {
    const config = AppConfig.parse({
      version: MIGRATIONS.length,
      jack: { internalUrl: 'http://jack:5225', apiKey: 'test-api-key' },
      servers: [],
      peers: [],
      security,
    })
    const sec = SecurityConfig.parse(security)
    return getApp(envs, config, { servers: [], peers: [] }, {
      ...makeAuthRepos(),
      arrAccess: () => ({ lanOnly: sec.lanOnlyArrApis, alsoAllowed: sec.arrApiAlsoAllowed, trustedProxies: sec.trustedProxies }),
      publicOpenApi: () => sec.publicOpenApi,
    })
  }

  test('/openapi.json is off unless security.publicOpenApi is on', async () => {
    expect((await secureApp().request('/openapi.json')).status).toBe(404)
    expect((await secureApp({ publicOpenApi: true }).request('/openapi.json')).status).toBe(200)
  })

  test('/torznab refuses an internet address before checking the key', async () => {
    const res = await secureApp().request('/torznab/api?t=caps&apikey=test-api-key', {}, from('203.0.113.9'))
    expect(res.status).toBe(403)
    expect((await secureApp().request('/torznab/api?t=caps&apikey=test-api-key', {}, from('192.168.0.20'))).status).toBe(200)
  })
})
