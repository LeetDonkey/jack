import type { Envs } from '../lib/envs'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { jsonc } from 'jsonc'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getApp } from '../app'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { AppConfig, getAppConfig, MIGRATIONS } from '../lib/config'
import { ConnectorManager } from '../lib/servers'
import { generateId } from '../lib/servers/base'
import { PeerConnector } from '../lib/servers/peer'
import { PROTOCOL_VERSION } from '../lib/version'
import { getManagementApp } from '../management-app'
import { ConfigService } from '../modules/config/config.service'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { ManagedApiKeys } from '../modules/managed-keys/managed-keys.service'
import { RegistrationService } from '../modules/registration/registration.service'
import { makeAuthRepos } from './helpers/auth-repos'

const config = AppConfig.parse({
  version: MIGRATIONS.length,
  jack: { internalUrl: 'http://localhost:3000', apiKey: 'test-api-key' },
  downloads: { completedPath: '/tmp/jack-test-completed' },
  servers: [],
  peers: [],
})

function makeEnvs(managementKey?: string): Envs {
  return {
    APP_CONFIG_PATH: '/data/config.json',
    ENABLE_LOGS: false,
    LOG_TO_FILE: false,
    LOG_MAX_FILE_BYTES: 10_485_760,
    LOG_MAX_FILES: 5,
    ENVIRONMENT: 'test' as any,
    HTTP_TIMEOUT_MS: 3000,
    LOG_LEVEL: 'fatal',
    OTEL_SERVICE_NAME: 'jack-server',
    PORT: 3000,
    MANAGEMENT_PORT: 5226,
    NODE_ENV: 'test',
    MANAGEMENT_KEY: managementKey,
  }
}

function markInitialized<T extends object>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return connector
}

function makePeer() {
  return markInitialized(new PeerConnector({ url: 'http://peer.test:3000', apiKey: 'peer-api-key', name: 'Friend Jack' }))
}

function mgmtApp(managementKey = 'mgmt-secret', peers = [makePeer()]) {
  return getManagementApp({ environment: 'test', managementKey, connectors: { servers: [], peers } })
}

describe('Management API auth', () => {
  test('GET /config/peers with valid key returns 200 + peers', async () => {
    const res = await mgmtApp().request('/config/peers', { headers: { 'X-Management-Key': 'mgmt-secret' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { peers: Array<{ name: string }> }
    expect(body.peers[0]?.name).toBe('Friend Jack')
  })

  test('GET /config/peers without key returns 401', async () => {
    const res = await mgmtApp().request('/config/peers')
    expect(res.status).toBe(401)
  })

  test('GET /config/peers with wrong key returns 401', async () => {
    const res = await mgmtApp().request('/config/peers', { headers: { 'X-Management-Key': 'wrong' } })
    expect(res.status).toBe(401)
  })

  test('the public app never exposes /config', async () => {
    const app = getApp(makeEnvs(undefined), config, { servers: [], peers: [makePeer()] } as any, { ...makeAuthRepos() })
    // Carry a valid peer API key so we get past requireApiKey and reach routing:
    // a true 404 proves the route is unregistered, not merely auth-blocked.
    const res = await app.request('/config', { headers: { 'x-api-key': 'test-api-key' } })
    expect(res.status).toBe(404)
  })

  test('mutation routes are absent (404) when no ConfigService is wired', async () => {
    // mgmtApp() injects no configService → canMutate is false → POST is unregistered.
    const res = await mgmtApp().request('/config/peers', {
      method: 'POST',
      headers: { 'X-Management-Key': 'mgmt-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }),
    })
    expect(res.status).toBe(404)
  })
})

const mswServer = setupServer(
  http.get('http://bob.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  http.get('http://bob.test:3000/peer/search', () => HttpResponse.json({ items: [
    { id: 'b:movie:1', title: 'Bob.Movie.1080p', filename: 'Bob.Movie.1080p.mkv', category: 2000, size: 1, imdbId: 'tt1', tmdbId: 1, publishDate: new Date().toISOString() },
  ] })),
  http.get('http://bob2.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  http.get('http://carol.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  // A peer that's reachable but rejects auth — its handshake 401s, so init fails.
  http.get('http://dead.test:3000/handshake', () => new HttpResponse(null, { status: 401 })),
  http.get('http://radarr-new.test:7878/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '4.0.0' })),
  // A server that's reachable but rejects auth — its status check 401s, so init fails.
  http.get('http://dead-radarr.test:7878/api/v3/system/status', () => new HttpResponse(null, { status: 401 })),
)
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => mswServer.close())

const tempFiles: string[] = []
const dbsToClose: Database[] = []
afterEach(async () => {
  mswServer.resetHandlers()
  for (const f of tempFiles.splice(0))
    await rm(f, { force: true })
  for (const db of dbsToClose.splice(0))
    db.close()
})

// `app` is the MANAGEMENT app (where /config lives); `mainApp` is the public peer
// app (where /torznab etc. live). Both share the same in-process connectorManager +
// configService, so a mutation on `app` is visible to `mainApp` (see Phase 7).
async function makeMutableApp(managementKey = 'mgmt-secret', { withRegistrations = false, registrationWaitMs }: { withRegistrations?: boolean, registrationWaitMs?: number } = {}) {
  const path = join(tmpdir(), `jack-config-${Math.random().toString(36).slice(2)}.jsonc`)
  tempFiles.push(path)
  await Bun.write(path, jsonc.stringify({ version: 1, peers: [], servers: [] }, { space: 2 }))
  const connectorManager = new ConnectorManager([], [])
  const database = new Database(':memory:')
  dbsToClose.push(database)
  database.exec('pragma foreign_keys = ON')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  const authRepos = makeAuthRepos(db)
  const downloadsRepository = new DownloadsRepository(db)
  const configService = await ConfigService.fromFile({ path, connectorManager, downloadsRepository })
  // Wired like index.ts: registration follows config saves.
  const registrations = withRegistrations
    ? new RegistrationService({
        managedKeys: new ManagedApiKeys(authRepos.managedKeysRepository),
        destinations: () => connectorManager.destinations,
        internalUrl: () => configService.getInternalUrl() ?? 'http://jack:5225',
        downloads: () => true,
        downloadsActive: () => true,
      })
    : undefined
  if (registrations)
    registrations.followConfig(configService)
  const app = getManagementApp({ environment: 'test', managementKey, connectors: connectorManager, configService, apiKeysRepository: authRepos.apiKeysRepository, registrations, registrationWaitMs })
  const mainApp = getApp(makeEnvs(managementKey), config, connectorManager, { downloadsRepository, ...authRepos })
  return { app, mainApp, path, connectorManager, downloadsRepository, database, configService, apiKeysRepository: authRepos.apiKeysRepository, registrations }
}

// A Radarr that keeps the download clients and indexers jack registers, and
// answers their tests like a real one: the client passes, the indexer finds no
// releases yet.
// `indexerTestGate` holds the indexer test until it resolves, like a slow feed.
function fakeArr(baseUrl: string, { indexerTestGate }: { indexerTestGate?: Promise<void> } = {}) {
  const state = { clients: [] as any[], indexers: [] as any[], tests: [] as string[], nextId: 1 }
  const crud = (kind: 'clients' | 'indexers', path: string) => [
    http.get(`${baseUrl}${path}`, () => HttpResponse.json(state[kind])),
    http.post(`${baseUrl}${path}`, async ({ request }) => {
      const created = { ...(await request.json() as object), id: state.nextId++ }
      state[kind].push(created)
      return HttpResponse.json(created)
    }),
    http.put(`${baseUrl}${path}/:id`, async ({ request, params }) => {
      const updated = await request.json() as { id: number }
      state[kind] = state[kind].map(item => (String(item.id) === String(params.id) ? updated : item))
      return HttpResponse.json(updated)
    }),
  ]
  mswServer.use(
    ...crud('clients', '/api/v3/downloadclient'),
    ...crud('indexers', '/api/v3/indexer'),
    http.post(`${baseUrl}/api/v3/downloadclient/test`, () => {
      state.tests.push('client')
      return HttpResponse.json('{}')
    }),
    http.post(`${baseUrl}/api/v3/indexer/test`, async () => {
      await indexerTestGate
      state.tests.push('indexer')
      return HttpResponse.json([{ propertyName: '', errorMessage: 'Query successful, but no results in the configured categories were returned from your indexer.', severity: 'error' }], { status: 400 })
    }),
  )
  return state
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the condition')
    await Bun.sleep(5)
  }
}

const KEY = { 'X-Management-Key': 'mgmt-secret' } as const

describe('ConnectorManager enabled filtering', () => {
  test('peers getter excludes a disabled peer but the connector stays resident', () => {
    const peer = makePeer()
    const manager = new ConnectorManager([], [])
    // Inject the peer into the live map, then disable it.
    ;(manager as any)._peerMap.set(peer.id, peer)
    expect(manager.peers).toHaveLength(1)

    manager.removeConnector(peer.id)
    expect(manager.peers).toHaveLength(0)
    // Still resident in the internal map (for in-flight drain).
    expect((manager as any)._peerMap.get(peer.id)).toBe(peer)
    expect(peer.enabled).toBe(false)
  })
})

describe('Management API addPeer', () => {
  test('adds a peer live and preserves the secret ref in the file', async () => {
    process.env.BOB_KEY = 'bob-secret'
    const { app, path, connectorManager } = await makeMutableApp()

    const res = await app.request('/config/peers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      // `bogus` is an unknown field — it must be stripped before persisting.
      body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: { env: 'BOB_KEY' }, bogus: 'x' }),
    })
    expect(res.status).toBe(201)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: Array<{ apiKey: unknown, bogus?: unknown }> }
    expect(onDisk.peers[0]?.apiKey).toEqual({ env: 'BOB_KEY' })
    expect(onDisk.peers[0]?.bogus).toBeUndefined()
    expect(connectorManager.peers.some(p => p.url === 'http://bob.test:3000')).toBe(true)
  })

  test('rejects a duplicate url with 409', async () => {
    process.env.BOB_KEY = 'bob-secret'
    const { app } = await makeMutableApp()
    const body = JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' })
    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body })
    const res = await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob2', url: 'http://bob.test:3000', apiKey: 'k' }) })
    expect(res.status).toBe(409)
  })

  test('a peer that fails its handshake is not persisted and the error is returned', async () => {
    const { app, path, connectorManager } = await makeMutableApp()

    const res = await app.request('/config/peers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dead', url: 'http://dead.test:3000', apiKey: 'k' }),
    })
    // The connectivity check failed → the add is rejected, not a silent 201.
    expect(res.status).toBe(502)
    const body = await res.json() as { ok: boolean, error: { message: string, code: string, reason: string, upstreamStatus: number | null } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('Dead')
    // The failure is classified for the UI; the code stays what it was.
    expect(body.error).toMatchObject({ code: 'CONNECTOR_INITIALIZATION_FAILED', reason: 'unauthorized', upstreamStatus: 401 })

    // Rolled back: nothing on disk, nothing resident in the connector map.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: unknown[] }
    expect(onDisk.peers).toHaveLength(0)
    expect(connectorManager.peers.some(p => p.url === 'http://dead.test:3000')).toBe(false)
    expect((connectorManager as any)._peerMap.has(generateId('http://dead.test:3000'))).toBe(false)
  })

  test('?force=true persists a peer that fails its handshake and keeps it resident', async () => {
    const { app, path, connectorManager } = await makeMutableApp()

    const res = await app.request('/config/peers?force=true', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dead', url: 'http://dead.test:3000', apiKey: 'k' }),
    })
    // force flips off rethrowInitError → the add succeeds despite the failed handshake.
    expect(res.status).toBe(201)

    // Persisted on disk and resident in the map so it auto-retries later.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: Array<{ url: string }> }
    expect(onDisk.peers).toHaveLength(1)
    expect(onDisk.peers[0]?.url).toBe('http://dead.test:3000')
    expect((connectorManager as any)._peerMap.has(generateId('http://dead.test:3000'))).toBe(true)
  })

  test('rejects an invalid body with 400', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'NoUrl' }) })
    expect(res.status).toBe(400)
    const body = await res.json() as { ok: boolean, error: { code: string, field: string, message: string } }
    expect(body.ok).toBe(false)
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'url' })
    expect(body.error.message).toStartWith('url: ')
  })

  test('a body that isn\'t valid JSON answers 400 in the same format', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: '{' })
    expect(res.status).toBe(400)
    const body = await res.json() as { ok: boolean, error: { code: string, field: string | null, issues: unknown[] } }
    expect(body.ok).toBe(false)
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: null, issues: [{ field: null, message: 'Malformed JSON in request body' }] })
  })

  test('a failed handshake with a peer that never answers is classified too', async () => {
    const { app } = await makeMutableApp()
    // Port 1 on localhost refuses at once; an IP literal needs no DNS lookup.
    const res = await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nobody', url: 'http://127.0.0.1:1', apiKey: 'k' }) })
    expect(res.status).toBe(502)
    expect((await res.json() as any).error).toMatchObject({ reason: 'refused', upstreamStatus: null })
  })

  test('tells listeners about every saved peer, with its id before the save', async () => {
    const { app, configService } = await makeMutableApp()
    const saved: Array<[string, string | null]> = []
    configService.onPeerSaved((id, previousId) => saved.push([id, previousId]))
    const post = (path: string, method: string, body: unknown) => app.request(path, { method, headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    expect((await post('/config/peers', 'POST', { name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' })).status).toBe(201)
    expect((await post(`/config/peers/${generateId('http://bob.test:3000')}`, 'PATCH', { name: 'Bob', url: 'http://bob2.test:3000', apiKey: 'k' })).status).toBe(200)
    // A failed save tells nobody.
    expect((await post('/config/peers', 'POST', { name: 'Dead', url: 'http://dead.test:3000', apiKey: 'k' })).status).toBe(502)

    expect(saved).toEqual([
      [generateId('http://bob.test:3000'), null],
      [generateId('http://bob2.test:3000'), generateId('http://bob.test:3000')],
    ])
  })

  test('serializes concurrent adds without losing an update', async () => {
    const { app, path } = await makeMutableApp()
    await Promise.all([
      app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }) }),
      app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Carol', url: 'http://carol.test:3000', apiKey: 'k' }) }),
    ])
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: unknown[] }
    expect(onDisk.peers).toHaveLength(2)
  })
})

describe('Management API remove/update peer', () => {
  const BOB = { name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }
  const bobId = generateId(BOB.url)

  async function addBob(app: Awaited<ReturnType<typeof makeMutableApp>>['app']) {
    return app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(BOB) })
  }

  test('removePeer drops it from file and fan-out', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await addBob(app)

    const res = await app.request(`/config/peers/${bobId}`, { method: 'DELETE', headers: KEY })
    expect(res.status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: unknown[] }
    expect(onDisk.peers).toHaveLength(0)
    expect(connectorManager.peers).toHaveLength(0)
  })

  test('updatePeer renames in file and live connector (same id)', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await addBob(app)

    const res = await app.request(`/config/peers/${bobId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...BOB, name: 'Bobby' }),
    })
    expect(res.status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: Array<{ name: string }> }
    expect(onDisk.peers[0]?.name).toBe('Bobby')
    expect(connectorManager.peers.find(p => p.id === bobId)?.name).toBe('Bobby')
  })

  test('an update whose new url fails its handshake rolls back', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await addBob(app)

    // Re-point Bob at a peer that 401s its handshake — the edit must be rejected.
    const res = await app.request(`/config/peers/${bobId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', url: 'http://dead.test:3000', apiKey: 'k' }),
    })
    expect(res.status).toBe(502)

    // Rolled back: still the working Bob on disk and resident in the map, no dead entry.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: Array<{ url: string }> }
    expect(onDisk.peers).toHaveLength(1)
    expect(onDisk.peers[0]?.url).toBe('http://bob.test:3000')
    expect(connectorManager.peers.some(p => p.id === bobId)).toBe(true)
    expect((connectorManager as any)._peerMap.has(generateId('http://dead.test:3000'))).toBe(false)
  })

  test('removePeer with unknown id returns 404', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/peers/deadbeef', { method: 'DELETE', headers: KEY })
    expect(res.status).toBe(404)
  })
})

describe('Management API servers', () => {
  const SERVER = {
    name: 'Radarr',
    url: 'http://radarr-new.test:7878',
    apiKey: 'a'.repeat(32),
    type: 'radarr',
    source: true,
    destination: true,
  }
  const serverId = generateId(SERVER.url)

  test('adds a server live and registers it as a source/destination', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    const res = await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })
    expect(res.status).toBe(201)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: unknown[] }
    expect(onDisk.servers).toHaveLength(1)
    expect(connectorManager.servers.some(s => s.id === serverId)).toBe(true)
    expect(connectorManager.sources.some(s => s.id === serverId)).toBe(true)
  })

  test('a key the service rejects answers in the same format as the route validator', async () => {
    const { app, connectorManager } = await makeMutableApp()
    const res = await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...SERVER, apiKey: 'not-a-radarr-key' }) })
    expect(res.status).toBe(400)
    const body = await res.json() as { ok: boolean, error: { code: string, field: string, message: string, issues: Array<{ field: string }> } }
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'apiKey' })
    expect(body.error.message).toStartWith('apiKey: ')
    expect(body.error.message).not.toContain('✖')
    expect(body.error.issues.every(issue => issue.field === 'apiKey')).toBe(true)
    expect(connectorManager.servers).toHaveLength(0)
  })

  test('removes a server', async () => {
    const { app, connectorManager } = await makeMutableApp()
    await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })
    const res = await app.request(`/config/servers/${serverId}`, { method: 'DELETE', headers: KEY })
    expect(res.status).toBe(200)
    expect(connectorManager.servers).toHaveLength(0)
  })

  test('a server that fails its status check is not persisted and the error is returned', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    const deadId = generateId('http://dead-radarr.test:7878')
    const res = await app.request('/config/servers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, name: 'DeadRadarr', url: 'http://dead-radarr.test:7878' }),
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { ok: boolean, error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('DeadRadarr')

    // Rolled back across every slice: file, server map, and the source/destination lists.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: unknown[] }
    expect(onDisk.servers).toHaveLength(0)
    expect(connectorManager.servers.some(s => s.id === deadId)).toBe(false)
    expect(connectorManager.sources.some(s => s.id === deadId)).toBe(false)
    expect(connectorManager.destinations.some(s => s.id === deadId)).toBe(false)
  })

  test('an update whose new url fails its status check rolls back', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })

    const res = await app.request(`/config/servers/${serverId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, url: 'http://dead-radarr.test:7878' }),
    })
    expect(res.status).toBe(502)

    // Rolled back: the working server keeps its url and stays a live source/destination.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: Array<{ url: string }> }
    expect(onDisk.servers[0]?.url).toBe('http://radarr-new.test:7878')
    expect(connectorManager.servers.some(s => s.id === serverId)).toBe(true)
    expect(connectorManager.sources.some(s => s.id === serverId)).toBe(true)
    expect(connectorManager.destinations.some(s => s.id === serverId)).toBe(true)
  })

  test('announces each saved server so jack can re-register in it, but not a rolled-back one', async () => {
    const { app, configService } = await makeMutableApp()
    const saved: string[] = []
    configService.onServerSaved((id) => {
      saved.push(id)
    })

    await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })
    await app.request(`/config/servers/${serverId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, autoregister: { enable: true, priority: 50 } }),
    })
    const failed = await app.request(`/config/servers/${serverId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, url: 'http://dead-radarr.test:7878' }),
    })

    expect(failed.status).toBe(502)
    expect(saved).toEqual([serverId, serverId])
  })

  test('stores an upgrade policy and reports it with defaults applied', async () => {
    const { app, path } = await makeMutableApp()
    await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })
    const before = await (await app.request('/config/servers', { headers: KEY })).json() as { servers: Array<{ upgrades: unknown }> }

    await app.request(`/config/servers/${serverId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, upgrades: { allow: true, maxSizeGiB: 20 } }),
    })
    const after = await (await app.request('/config/servers', { headers: KEY })).json() as { servers: Array<{ upgrades: unknown }> }

    expect(before.servers[0]?.upgrades).toEqual({ allow: true, maxSizeGiB: null })
    expect(after.servers[0]?.upgrades).toEqual({ allow: true, maxSizeGiB: 20 })
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: Array<{ upgrades?: unknown }> }
    expect(onDisk.servers[0]?.upgrades).toEqual({ allow: true, maxSizeGiB: 20 })
  })

  test('rejects an indexer priority *arr would refuse', async () => {
    const { app, path } = await makeMutableApp()
    await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })

    const res = await app.request(`/config/servers/${serverId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, autoregister: { enable: true, priority: 51 } }),
    })

    expect(res.status).toBe(400)
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: Array<{ autoregister?: unknown }> }
    expect(onDisk.servers[0]?.autoregister).toBeUndefined()
  })
})

describe('Management API GET /config exposes refs-intact secrets', () => {
  test('returns the persisted apiKey + header refs without resolving them', async () => {
    process.env.PEER_KEY = 'peer-secret'
    process.env.PEER_HEADER = 'header-secret'
    const { app } = await makeMutableApp()

    await app.request('/config/peers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob',
        url: 'http://bob.test:3000',
        apiKey: { env: 'PEER_KEY' },
        headers: { 'X-Plain': 'literal', 'X-Secret': { env: 'PEER_HEADER' } },
      }),
    })

    const res = await app.request('/config/peers', { headers: KEY })
    expect(res.status).toBe(200)
    const body = await res.json() as { peers: Array<{ apiKey: unknown, headers: Record<string, unknown> }> }
    // Refs come back exactly as stored — never resolved into the secret value.
    expect(body.peers[0]?.apiKey).toEqual({ env: 'PEER_KEY' })
    expect(body.peers[0]?.headers).toEqual({ 'X-Plain': 'literal', 'X-Secret': { env: 'PEER_HEADER' } })
  })

  test('read-only app (no ConfigService) omits the secret fields', async () => {
    // mgmtApp() wires no ConfigService, so there is no refs-intact source to read
    // from — apiKey/headers are absent rather than resolved off the live connector.
    const res = await mgmtApp().request('/config/peers', { headers: KEY })
    const body = await res.json() as { peers: Array<Record<string, unknown>> }
    expect(body.peers[0]).not.toHaveProperty('apiKey')
    expect(body.peers[0]).not.toHaveProperty('headers')
  })

  test('servers expose every editable field: apiKey ref + headers + autoregister', async () => {
    process.env.SERVER_KEY = 'a'.repeat(32)
    const { app } = await makeMutableApp()

    await app.request('/config/servers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Radarr',
        url: 'http://radarr-new.test:7878',
        apiKey: { env: 'SERVER_KEY' },
        type: 'radarr',
        headers: { 'X-Trace': 'on' },
        autoregister: { enable: true, priority: 7 },
      }),
    })

    const res = await app.request('/config/servers', { headers: KEY })
    expect(res.status).toBe(200)
    const body = await res.json() as { servers: Array<{ apiKey: unknown, headers: unknown, autoregister: unknown, source: boolean, destination: boolean }> }
    expect(body.servers[0]?.apiKey).toEqual({ env: 'SERVER_KEY' })
    expect(body.servers[0]?.headers).toEqual({ 'X-Trace': 'on' })
    // autoregister is the effective (defaults-applied) value off the live connector.
    expect(body.servers[0]?.autoregister).toEqual({ enable: true, priority: 7 })
  })
})

describe('Management API live visibility', () => {
  test('a live-added peer is searchable via /torznab without restart', async () => {
    // `app` = management app (/config); `mainApp` = public app (/torznab). Same
    // in-process connectorManager, so a mutation on one is visible to the other.
    const { app, mainApp } = await makeMutableApp()

    // Before: empty feed (queried on the PUBLIC app).
    const before = await (await mainApp.request('/torznab/api?t=search&apikey=test-api-key')).text()
    expect(before).not.toContain('Bob.Movie.1080p')

    // Add via the MANAGEMENT app.
    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }) })

    // After add: the peer's catalog appears live on the public feed.
    const after = await (await mainApp.request('/torznab/api?t=search&apikey=test-api-key')).text()
    expect(after).toContain('Bob.Movie.1080p')

    // After remove: gone again.
    const { generateId } = await import('../lib/servers/base')
    await app.request(`/config/peers/${generateId('http://bob.test:3000')}`, { method: 'DELETE', headers: KEY })
    const removed = await (await mainApp.request('/torznab/api?t=search&apikey=test-api-key')).text()
    expect(removed).not.toContain('Bob.Movie.1080p')
  })

  test('a live-added peer appears in GET /config/peers without restart', async () => {
    // Connector listing lives only on the management API now. This covers the
    // lazy-getter-OBJECT wiring (ConfigController); the /torznab test above covers
    // the () => Connector[] PROVIDER wiring on the public app.
    const { app } = await makeMutableApp()

    const before = await (await app.request('/config/peers', { headers: KEY })).json() as { peers: Array<{ name: string }> }
    expect(before.peers.some(p => p.name === 'Bob')).toBe(false)

    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }) })

    const after = await (await app.request('/config/peers', { headers: KEY })).json() as { peers: Array<{ name: string }> }
    expect(after.peers.some(p => p.name === 'Bob')).toBe(true)
  })
})

describe('Management API updatePeer url change', () => {
  test('rekeys the connector map and cascades download rows', async () => {
    const { app, connectorManager, downloadsRepository } = await makeMutableApp()
    const urlA = 'http://bob.test:3000'
    const urlB = 'http://bob2.test:3000'
    const idA = generateId(urlA)
    const idB = generateId(urlB)

    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: urlA, apiKey: 'k' }) })

    const dl = downloadsRepository.create({
      torrentFilename: 'm.torrent',
      peerId: idA,
      peerName: 'Bob',
      itemId: 'movie:1',
      filename: 'm.mkv',
      destPath: '/tmp/m.mkv',
      partPath: '/tmp/m.mkv.part',
      releaseSize: 1,
      release: { id: 'r', title: 'm', filename: 'm.mkv', category: 2000, size: 1 } as any,
    })

    const res = await app.request(`/config/peers/${idA}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', url: urlB, apiKey: 'k' }),
    })
    expect(res.status).toBe(200)

    expect(connectorManager.peers.some(p => p.id === idB)).toBe(true)
    expect(connectorManager.peers.some(p => p.id === idA)).toBe(false)
    expect(downloadsRepository.get(dl.id)?.peerId).toBe(idB)
  })
})

describe('Management API jack config', () => {
  test('GET /config/jack returns null when no jack block is configured', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/jack', { headers: KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  test('PATCH then GET round-trips internalUrl + apiKey ref intact on disk', async () => {
    // JackConfig.parse resolves {env} refs to validate them (mirrors the addPeer
    // path), so the referenced var must exist — exactly as the addPeer test sets
    // process.env.BOB_KEY before posting { env: 'BOB_KEY' }.
    process.env.JACK_X = 'jack-secret'
    const { app, path } = await makeMutableApp()

    const patch = await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ internalUrl: 'http://jack.test:5225', apiKey: { env: 'JACK_X' } }),
    })
    expect(patch.status).toBe(200)
    expect(await patch.json()).toEqual({ ok: true })

    // The ref is preserved on disk — never resolved into the secret value.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { jack: { internalUrl: string, apiKey: unknown } }
    expect(onDisk.jack).toEqual({ internalUrl: 'http://jack.test:5225', apiKey: { env: 'JACK_X' } })

    const get = await app.request('/config/jack', { headers: KEY })
    expect(await get.json()).toEqual({ internalUrl: 'http://jack.test:5225', apiKey: { env: 'JACK_X' } })
  })

  test('PATCH preserves external header refs while the service resolves them on demand', async () => {
    process.env.CF_ACCESS_ID = 'resolved-client-id'
    const { app, path, configService } = await makeMutableApp()

    const patch = await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        internalUrl: 'http://jack.test:5225',
        external: {
          instanceName: 'Roz’s Jack',
          url: 'https://jack.example.com',
          headers: {
            'CF-Access-Client-Id': { env: 'CF_ACCESS_ID' },
            'CF-Access-Client-Secret': 'literal-secret',
          },
          ignored: true,
        },
      }),
    })
    expect(patch.status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { jack: { external: unknown } }
    expect(onDisk.jack.external).toEqual({
      instanceName: 'Roz’s Jack',
      url: 'https://jack.example.com',
      headers: {
        'CF-Access-Client-Id': { env: 'CF_ACCESS_ID' },
        'CF-Access-Client-Secret': 'literal-secret',
      },
    })

    const get = await app.request('/config/jack', { headers: KEY })
    expect((await get.json() as any).external.headers['CF-Access-Client-Id']).toEqual({ env: 'CF_ACCESS_ID' })
    expect(configService.getResolvedExternalJack()).toEqual({
      instanceName: 'Roz’s Jack',
      url: 'https://jack.example.com',
      headers: {
        'CF-Access-Client-Id': 'resolved-client-id',
        'CF-Access-Client-Secret': 'literal-secret',
      },
    })
  })

  test('PATCH with no apiKey persists a jack block without one (optional)', async () => {
    const { app, path } = await makeMutableApp()

    const res = await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ internalUrl: 'http://jack.test:5225' }),
    })
    expect(res.status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { jack: { internalUrl: string, apiKey?: unknown } }
    expect(onDisk.jack.internalUrl).toBe('http://jack.test:5225')
    expect(onDisk.jack.apiKey).toBeUndefined()

    const get = await app.request('/config/jack', { headers: KEY })
    const body = await get.json() as { internalUrl: string, apiKey?: unknown }
    expect(body.apiKey).toBeUndefined()
  })

  test('PATCH merges: an absent key keeps its value, null removes it, external stays', async () => {
    process.env.TMDB_X = 'tmdb-secret'
    const { app, path } = await makeMutableApp()
    const patch = (body: unknown) => app.request('/config/jack', { method: 'PATCH', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    expect((await patch({ internalUrl: 'http://jack.test:5225', apiKey: 'main', tmdbApiKey: { env: 'TMDB_X' }, external: { url: 'https://jack.example.com' } })).status).toBe(200)
    expect((await patch({ internalUrl: 'http://192.168.1.10:5225' })).status).toBe(200)
    const onDisk = () => Bun.file(path).text().then(text => (jsonc.parse(text) as { jack: Record<string, unknown> }).jack)
    expect(await onDisk()).toEqual({ internalUrl: 'http://192.168.1.10:5225', apiKey: 'main', tmdbApiKey: { env: 'TMDB_X' }, external: { url: 'https://jack.example.com' } })

    expect((await patch({ apiKey: null })).status).toBe(200)
    expect(await onDisk()).toEqual({ internalUrl: 'http://192.168.1.10:5225', tmdbApiKey: { env: 'TMDB_X' }, external: { url: 'https://jack.example.com' } })

    // internalUrl can't be removed.
    expect((await patch({ internalUrl: null })).status).toBe(400)
  })

  test('a first PATCH must set internalUrl', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/jack', { method: 'PATCH', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'main' }) })
    expect(res.status).toBe(400)
  })

  test('announces each saved jack block with the one it replaced', async () => {
    const { app, configService } = await makeMutableApp()
    const saved: Array<[unknown, unknown]> = []
    configService.onJackSaved((previous, next) => {
      saved.push([previous?.internalUrl ?? null, next.internalUrl])
    })
    for (const internalUrl of ['http://jack:5225', 'http://192.168.1.10:5225'])
      await app.request('/config/jack', { method: 'PATCH', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ internalUrl }) })
    expect(saved).toEqual([[null, 'http://jack:5225'], ['http://jack:5225', 'http://192.168.1.10:5225']])
  })

  test('PATCH with an invalid internalUrl returns 400', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ internalUrl: 'not-a-url' }),
    })
    expect(res.status).toBe(400)
  })

  test('PATCH /config/jack is unregistered (404) without a ConfigService', async () => {
    const res = await mgmtApp().request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ internalUrl: 'http://jack.test:5225' }),
    })
    expect(res.status).toBe(404)
  })

  test('PATCH /config/jack/external updates only external config during a concurrent Jack save', async () => {
    const { app } = await makeMutableApp()
    await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        internalUrl: 'http://jack.test:5225',
        external: { instanceName: 'Old name', url: 'https://old.example.com' },
      }),
    })

    const [jackPatch, externalPatch] = await Promise.all([
      app.request('/config/jack', {
        method: 'PATCH',
        headers: { ...KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ internalUrl: 'http://jack-new.test:5225' }),
      }),
      app.request('/config/jack/external', {
        method: 'PATCH',
        headers: { ...KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceName: 'Roz’s Jack', url: 'https://jack.example.com' }),
      }),
    ])

    expect(jackPatch.status).toBe(200)
    expect(externalPatch.status).toBe(200)
    const get = await app.request('/config/jack', { headers: KEY })
    expect(await get.json()).toMatchObject({
      internalUrl: 'http://jack-new.test:5225',
      external: { instanceName: 'Roz’s Jack', url: 'https://jack.example.com' },
    })
  })

  test('DELETE /config/jack/external removes external config only', async () => {
    const { app } = await makeMutableApp()
    await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        internalUrl: 'http://jack.test:5225',
        external: { instanceName: 'Roz’s Jack', url: 'https://jack.example.com' },
      }),
    })

    const remove = await app.request('/config/jack/external', {
      method: 'DELETE',
      headers: KEY,
    })
    expect(remove.status).toBe(200)

    const get = await app.request('/config/jack', { headers: KEY })
    const body = await get.json() as Record<string, unknown>
    expect(body.internalUrl).toBe('http://jack.test:5225')
    expect(body.external).toBeUndefined()
  })
})

describe('Management API quick links', () => {
  test('POST /quick-links returns a ready-to-share link with resolved headers and a fresh key', async () => {
    process.env.CF_ACCESS_ID = 'resolved-client-id'
    const { app, apiKeysRepository } = await makeMutableApp()

    await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        internalUrl: 'http://jack.test:5225',
        external: {
          instanceName: 'Roz’s Jack',
          url: 'https://jack.example.com',
          headers: { 'CF-Access-Client-Id': { env: 'CF_ACCESS_ID' } },
        },
      }),
    })

    const res = await app.request('/quick-links', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerName: 'Roz’s Jack',
        keyName: 'Friend access',
        keyDescription: 'Shared with a friend',
      }),
    })

    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json() as { link: string, key: Record<string, unknown> }
    expect(body.link.startsWith('jack-link:v1:')).toBe(true)
    expect(body.key).not.toHaveProperty('key')
    expect(body.key).toMatchObject({ name: 'Friend access', description: 'Shared with a friend' })

    const encoded = body.link.slice('jack-link:v1:'.length)
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      v: number
      type: string
      name: string
      url: string
      apiKey: string
      headers: Record<string, string>
    }
    expect(payload).toEqual({
      v: 1,
      type: 'peer',
      name: 'Roz’s Jack',
      url: 'https://jack.example.com',
      apiKey: expect.any(String),
      headers: { 'CF-Access-Client-Id': 'resolved-client-id' },
    })
    expect(apiKeysRepository.resolve(payload.apiKey).status).toBe('ok')
  })

  test('does not create an API key when the external profile is missing', async () => {
    const { app, apiKeysRepository } = await makeMutableApp()
    const res = await app.request('/quick-links', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerName: 'Friend Jack', keyName: 'Friend access' }),
    })

    expect(res.status).toBe(400)
    expect(apiKeysRepository.list()).toHaveLength(0)
  })

  test('does not create an API key when an external secret can no longer resolve', async () => {
    process.env.TEMP_EXTERNAL_HEADER = 'available-while-saving'
    const { app, apiKeysRepository } = await makeMutableApp()
    await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        internalUrl: 'http://jack.test:5225',
        external: {
          url: 'https://jack.example.com',
          headers: { Authorization: { env: 'TEMP_EXTERNAL_HEADER' } },
        },
      }),
    })
    delete process.env.TEMP_EXTERNAL_HEADER

    const res = await app.request('/quick-links', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerName: 'Friend Jack', keyName: 'Friend access' }),
    })

    expect(res.status).toBe(400)
    expect(apiKeysRepository.list()).toHaveLength(0)
  })

  test('revokes the fresh API key when the generated link exceeds the import limit', async () => {
    const { app, apiKeysRepository } = await makeMutableApp()
    await app.request('/config/jack', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        internalUrl: 'http://jack.test:5225',
        external: {
          url: 'https://jack.example.com',
          headers: { Authorization: 'x'.repeat(30_000) },
        },
      }),
    })

    const res = await app.request('/quick-links', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerName: 'Friend Jack', keyName: 'Friend access' }),
    })

    expect(res.status).toBe(400)
    expect(apiKeysRepository.list()).toHaveLength(0)
  })

  test('the public app never exposes /quick-links', async () => {
    const { mainApp } = await makeMutableApp()
    const res = await mainApp.request('/quick-links', { method: 'POST', headers: { 'x-api-key': 'test-api-key' } })
    expect(res.status).toBe(404)
  })
})

describe('Management API downloads config', () => {
  // A real folder: saving completedPath checks that jack can write to it.
  let completedDir = ''
  beforeAll(async () => {
    completedDir = await mkdtemp(join(tmpdir(), 'jack-completed-'))
  })
  afterAll(async () => {
    await rm(completedDir, { recursive: true, force: true })
  })

  // Seed a config file that already carries a downloads block, so the partial-patch
  // behaviour (merge onto what's stored) has something to merge onto.
  async function withDownloadsBlock(app: ReturnType<typeof mgmtApp>, path: string) {
    const res = await app.request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ completedPath: completedDir, maxConcurrentDownloads: 5 }),
    })
    expect(res.status).toBe(200)
    return path
  }

  test('GET /config/downloads returns null when no downloads block is configured', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/downloads', { headers: KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  test('PATCH merges into the stored block instead of replacing it', async () => {
    const { app, path } = await makeMutableApp()
    await withDownloadsBlock(app, path)

    const res = await app.request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlinkImportedFiles: true }),
    })
    expect(res.status).toBe(200)

    // The unrelated knobs survive, and only what was set is written — defaults are
    // never baked into the file.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { downloads: Record<string, unknown> }
    expect(onDisk.downloads).toEqual({ completedPath: completedDir, maxConcurrentDownloads: 5, unlinkImportedFiles: true })

    const get = await app.request('/config/downloads', { headers: KEY })
    expect(await get.json()).toMatchObject({ unlinkImportedFiles: true, maxConcurrentDownloads: 5 })
  })

  test('PATCH with null drops the key so the schema default applies again', async () => {
    const { app, path } = await makeMutableApp()
    await withDownloadsBlock(app, path)

    const res = await app.request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrentDownloads: null }),
    })
    expect(res.status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { downloads: Record<string, unknown> }
    expect(onDisk.downloads).toEqual({ completedPath: completedDir })
    expect('maxConcurrentDownloads' in onDisk.downloads).toBe(false)
  })

  test('PATCH rejects clearing completedPath, which has no default to fall back to', async () => {
    const { app, path } = await makeMutableApp()
    await withDownloadsBlock(app, path)

    const res = await app.request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ completedPath: null }),
    })
    expect(res.status).toBe(400)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { downloads: Record<string, unknown> }
    expect(onDisk.downloads.completedPath).toBe(completedDir)
  })

  test('PATCH rejects a first patch that leaves the merged block without completedPath', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlinkImportedFiles: true }),
    })
    expect(res.status).toBe(400)
  })

  test('PATCH with a non-boolean unlinkImportedFiles returns 400', async () => {
    const { app, path } = await makeMutableApp()
    await withDownloadsBlock(app, path)

    const res = await app.request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlinkImportedFiles: 'yes' }),
    })
    expect(res.status).toBe(400)
  })

  test('PATCH refuses a completed folder jack can\'t write to', async () => {
    const { app, path } = await makeMutableApp()
    const missing = join(completedDir, 'not-mounted')
    const res = await app.request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ completedPath: missing }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string, field: string, issues: Array<{ field: string, message: string }> } }
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'completedPath' })
    expect(body.error.issues).toEqual([{ field: 'completedPath', message: `jack can't write to ${missing}. Check the Downloads path in the jack template.` }])
    expect((jsonc.parse(await Bun.file(path).text()) as { downloads?: unknown }).downloads).toBeUndefined()
  })

  test('announces each save, with null as the previous block when downloads were just turned on', async () => {
    const { app, path, configService } = await makeMutableApp()
    const saved: Array<[unknown, unknown]> = []
    configService.onDownloadsSaved((previous, next) => {
      saved.push([previous?.maxConcurrentDownloads ?? previous, next.maxConcurrentDownloads])
    })
    await withDownloadsBlock(app, path)
    await app.request('/config/downloads', { method: 'PATCH', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConcurrentDownloads: 2 }) })
    expect(saved).toEqual([[null, 5], [5, 2]])
  })

  test('PATCH /config/downloads is unregistered (404) without a ConfigService', async () => {
    const res = await mgmtApp().request('/config/downloads', {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlinkImportedFiles: true }),
    })
    expect(res.status).toBe(404)
  })
})

describe('Management API bandwidth config', () => {
  const patch = (app: ReturnType<typeof mgmtApp>, body: unknown) => app.request('/config/bandwidth', {
    method: 'PATCH',
    headers: { ...KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  test('GET /config/bandwidth returns null when no bandwidth block is configured', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/bandwidth', { headers: KEY })
    expect(await res.json()).toBeNull()
  })

  test('PATCH stores limits and a schedule, merges later patches and drops nulls', async () => {
    const { app, path } = await makeMutableApp()
    const schedule = [{ days: ['mon', 'fri'], start: '07:00', end: '23:00', downloadLimitKiBps: 20480 }]

    expect((await patch(app, { uploadLimitKiBps: 5120, maxConcurrentUploads: 2, schedule })).status).toBe(200)
    expect((await patch(app, { maxConcurrentUploads: null })).status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { bandwidth: Record<string, unknown> }
    expect(onDisk.bandwidth).toEqual({ uploadLimitKiBps: 5120, schedule })

    const get = await app.request('/config/bandwidth', { headers: KEY })
    expect(await get.json()).toEqual({ uploadLimitKiBps: 5120, schedule })
  })

  test('PATCH rejects a malformed schedule period', async () => {
    const { app } = await makeMutableApp()
    const res = await patch(app, { schedule: [{ days: ['someday'], start: '7', end: '23:00' }] })
    expect(res.status).toBe(400)
  })
})

describe('Management API security config', () => {
  const patch = (app: ReturnType<typeof mgmtApp>, body: unknown) => app.request('/config/security', {
    method: 'PATCH',
    headers: { ...KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  test('PATCH stores addresses and ranges of both families', async () => {
    const { app, path } = await makeMutableApp()
    const lists = { trustedProxies: ['172.18.0.0/16', ' 10.0.0.5 '], neverBan: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'], arrApiAlsoAllowed: ['2001:db8::1', '[::1]'] }
    expect((await patch(app, lists)).status).toBe(200)
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { security: Record<string, unknown> }
    expect(onDisk.security).toEqual({ ...lists, trustedProxies: ['172.18.0.0/16', '10.0.0.5'] })
  })

  test('PATCH refuses an entry that isn\'t an address or range, naming it on its field', async () => {
    const { app, path } = await makeMutableApp()
    for (const [field, list, bad] of [
      ['trustedProxies', ['172.18.0.0/16', 'Nginx'], 'Nginx'],
      ['neverBan', ['10.0.0.0/33'], '10.0.0.0/33'],
      ['arrApiAlsoAllowed', ['fd00::/129'], 'fd00::/129'],
      ['neverBan', ['npm'], 'npm'],
      ['trustedProxies', ['192.168.1.300'], '192.168.1.300'],
      ['trustedProxies', ['10.0.0.0/8/8'], '10.0.0.0/8/8'],
      ['neverBan', ['fe80::1%eth0'], 'fe80::1%eth0'],
    ] as const) {
      const res = await patch(app, { [field]: list })
      expect(res.status).toBe(400)
      const { error } = await res.json() as { error: { code: string, field: string, message: string } }
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.field).toBe(`${field}.${list.indexOf(bad as never)}`)
      expect(error.message).toContain(`"${bad}" isn't an IP address or range`)
    }
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { security?: unknown }
    expect(onDisk.security).toBeUndefined()
  })

  test('a stored list with entries that aren\'t addresses still loads, without them', async () => {
    const path = join(tmpdir(), `jack-config-${Math.random().toString(36).slice(2)}.jsonc`)
    tempFiles.push(path)
    const security = { trustedProxies: ['Nginx', 'Proxy', 'Manager'], neverBan: ['100.64.0.0/10', 'tailscale'], arrApiAlsoAllowed: [] }
    await Bun.write(path, jsonc.stringify({ version: MIGRATIONS.length, jack: { internalUrl: 'http://jack:5225' }, security, peers: [], servers: [] }))

    const { appConfig } = await getAppConfig({ APP_CONFIG_PATH: path })
    // A list with nothing usable left falls back to its default (every private proxy).
    expect(appConfig.security).toMatchObject({ trustedProxies: null, neverBan: ['100.64.0.0/10'], arrApiAlsoAllowed: [] })

    const configService = await ConfigService.fromFile({ path, connectorManager: new ConnectorManager([], []) })
    const app = getManagementApp({ environment: 'test', managementKey: 'mgmt-secret', connectors: { servers: [], peers: [] }, configService })
    expect(await (await app.request('/config/security', { headers: KEY })).json()).toMatchObject({ trustedProxies: null, neverBan: ['100.64.0.0/10'] })

    // Saving another setting keeps working.
    expect((await patch(app, { banEnabled: false })).status).toBe(200)
    expect(configService.getSecurity()).toMatchObject({ banEnabled: false, neverBan: ['100.64.0.0/10'] })
  })
})

describe('Management API registration', () => {
  const SERVER = {
    name: 'Radarr',
    url: 'http://radarr-new.test:7878',
    apiKey: 'a'.repeat(32),
    type: 'radarr',
  }
  const serverId = generateId(SERVER.url)
  const json = { ...KEY, 'Content-Type': 'application/json' }

  test('POST /config/servers answers once jack is registered and Radarr tested it', async () => {
    const radarr = fakeArr(SERVER.url)
    const { app } = await makeMutableApp('mgmt-secret', { withRegistrations: true })

    const res = await app.request('/config/servers', { method: 'POST', headers: json, body: JSON.stringify(SERVER) })
    expect(res.status).toBe(201)
    const body = await res.json() as { ok: boolean, registration: Record<string, unknown> }
    expect(body).toMatchObject({
      ok: true,
      registration: {
        indexer: { status: 'ok' },
        downloadClient: { status: 'ok' },
        clientTest: 'ok',
        // No friend has releases yet: "no results" still proves Radarr reached jack.
        indexerTest: 'ok',
        message: null,
      },
    })
    expect(radarr.clients.map(c => c.name)).toEqual(['Jack'])
    expect(radarr.indexers[0]?.downloadClientId).toBe(radarr.clients[0]?.id)
    expect(radarr.tests.sort()).toEqual(['client', 'indexer'])

    const list = await (await app.request('/config/servers', { headers: KEY })).json() as { servers: Array<{ registration: unknown, lastContactAt: unknown }> }
    expect(list.servers[0]?.registration).toEqual(body.registration)
    expect(list.servers[0]?.lastContactAt).toBeNull()
  })

  test('PATCH /config/servers/:id answers with the new registration', async () => {
    const radarr = fakeArr(SERVER.url)
    const { app } = await makeMutableApp('mgmt-secret', { withRegistrations: true })
    await app.request('/config/servers', { method: 'POST', headers: json, body: JSON.stringify(SERVER) })

    const res = await app.request(`/config/servers/${serverId}`, { method: 'PATCH', headers: json, body: JSON.stringify({ ...SERVER, autoregister: { enable: true, priority: 25 } }) })
    expect(res.status).toBe(200)
    expect((await res.json() as { registration: { indexer: unknown } }).registration.indexer).toEqual({ status: 'ok' })
    expect(radarr.indexers).toHaveLength(1)
    expect(radarr.indexers[0]?.priority).toBe(25)
  })

  test('a server jack doesn\'t register in answers with a null registration', async () => {
    const { app } = await makeMutableApp('mgmt-secret', { withRegistrations: true })
    const res = await app.request('/config/servers', { method: 'POST', headers: json, body: JSON.stringify({ ...SERVER, destination: false }) })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, registration: null, registrationPending: false })

    const again = await app.request(`/config/servers/${serverId}/register`, { method: 'POST', headers: KEY })
    expect(again.status).toBe(400)
  })

  test('POST /config/servers/:id/register registers again with a new key', async () => {
    const radarr = fakeArr(SERVER.url)
    const { app } = await makeMutableApp('mgmt-secret', { withRegistrations: true })
    await app.request('/config/servers', { method: 'POST', headers: json, body: JSON.stringify(SERVER) })
    const firstKey = radarr.indexers[0]?.fields.find((f: { name: string }) => f.name === 'apiKey')?.value

    const res = await app.request(`/config/servers/${serverId}/register`, { method: 'POST', headers: KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, registration: { clientTest: 'ok', indexerTest: 'ok' }, registrationPending: false })
    expect(radarr.indexers[0]?.fields.find((f: { name: string }) => f.name === 'apiKey')?.value).not.toBe(firstKey)

    expect((await app.request('/config/servers/unknown/register', { method: 'POST', headers: KEY })).status).toBe(404)
  })

  test('a slow registration answers with registrationPending, and the result lands on the server list later', async () => {
    let release!: () => void
    const indexerTestGate = new Promise<void>((resolve) => {
      release = resolve
    })
    fakeArr(SERVER.url, { indexerTestGate })
    const { app, registrations } = await makeMutableApp('mgmt-secret', { withRegistrations: true, registrationWaitMs: 20 })

    try {
      const res = await app.request('/config/servers', { method: 'POST', headers: json, body: JSON.stringify(SERVER) })
      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ ok: true, registration: null, registrationPending: true })

      const again = await app.request(`/config/servers/${serverId}/register`, { method: 'POST', headers: KEY })
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ ok: true, registration: null, registrationPending: true })
    }
    finally {
      release()
    }
    await waitFor(() => registrations!.registration(serverId)?.indexerTest === 'ok')
    const list = await (await app.request('/config/servers', { headers: KEY })).json() as { servers: Array<{ registration: { indexerTest: string } | null }> }
    expect(list.servers[0]?.registration?.indexerTest).toBe('ok')
  })

  test('the register route is absent without a registration service', async () => {
    const { app } = await makeMutableApp()
    expect((await app.request(`/config/servers/${serverId}/register`, { method: 'POST', headers: KEY })).status).toBe(404)
  })

  test('a new internal URL moves jack\'s indexer and client in Radarr without a restart', async () => {
    const radarr = fakeArr(SERVER.url)
    const { app } = await makeMutableApp('mgmt-secret', { withRegistrations: true })
    await app.request('/config/jack', { method: 'PATCH', headers: json, body: JSON.stringify({ internalUrl: 'http://jack:5225' }) })
    await app.request('/config/servers', { method: 'POST', headers: json, body: JSON.stringify(SERVER) })

    await app.request('/config/jack', { method: 'PATCH', headers: json, body: JSON.stringify({ internalUrl: 'http://192.168.1.10:5225' }) })
    const baseUrl = () => radarr.indexers[0]?.fields.find((f: { name: string }) => f.name === 'baseUrl')?.value
    await waitFor(() => baseUrl() === 'http://192.168.1.10:5225/torznab')
    expect(radarr.indexers).toHaveLength(1)
    expect(radarr.clients[0]?.fields).toContainEqual({ name: 'host', value: '192.168.1.10' })
  })
})
