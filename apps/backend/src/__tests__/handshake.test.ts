import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { getApp } from '../app'
import { AppConfig, MIGRATIONS } from '../lib/config'
import { PROTOCOL_VERSION } from '../lib/version'
import { PeerHealthMonitor } from '../modules/friends/peer-health'
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

describe('GET /handshake build', () => {
  test('adds the build when the image was built with a revision', async () => {
    process.env.JACK_BUILD_REVISION = '4ca4a2a'
    process.env.JACK_BUILD_DATE = '2026-10-17T08:30:00Z'
    try {
      const res = await buildApp().request('/handshake?apikey=test-api-key')
      expect(await res.json()).toEqual({ name: 'jack', version: PROTOCOL_VERSION, build: { revision: '4ca4a2a', buildDate: '2026-10-17T08:30:00.000Z' } })
    }
    finally {
      delete process.env.JACK_BUILD_REVISION
      delete process.env.JACK_BUILD_DATE
    }
  })

  test('the health check keeps the build a peer reports', async () => {
    let handshake: unknown = { name: 'jack', version: PROTOCOL_VERSION, build: { revision: 'abc1234', buildDate: null } }
    const peer = { id: 'p1', name: 'Alice', url: 'http://alice.test', isInitialized: true, init: () => {}, ping: async () => handshake }
    const monitor = new PeerHealthMonitor(() => [peer as any], () => 60_000)

    await monitor.checkAll()
    expect(monitor.get(peer).build).toEqual({ revision: 'abc1234', buildDate: null })

    handshake = { name: 'jack', version: PROTOCOL_VERSION }
    await monitor.checkAll()
    expect(monitor.get(peer).build).toBeNull()
  })
})
