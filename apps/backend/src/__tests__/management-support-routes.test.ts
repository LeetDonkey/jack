import { describe, expect, test } from 'bun:test'
import { getManagementApp } from '../management-app'
import { TransfersService } from '../modules/transfers/transfers.service'

const KEY = { 'X-Management-Key': 'mgmt-secret-key' } as const

function makeApp(extra: Partial<Parameters<typeof getManagementApp>[0]> = {}) {
  return getManagementApp({
    environment: 'test',
    managementKey: 'mgmt-secret-key',
    connectors: { servers: [], peers: [] },
    version: () => ({ version: '0.1.0', revision: '4ca4a2a', buildDate: '2026-10-17T08:30:00.000Z' }),
    ...extra,
  })
}

describe('management support routes', () => {
  test('GET /version answers the version and build', async () => {
    const res = await makeApp().request('/version', { headers: KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: '0.1.0', revision: '4ca4a2a', buildDate: '2026-10-17T08:30:00.000Z' })
    expect((await makeApp().request('/version')).status).toBe(401)
  })

  test('GET /support-bundle answers a redacted bundle without the management key', async () => {
    const res = await makeApp({ system: () => ({ bootedAt: '2026-10-18T09:00:00.000Z', restartPending: ['downloads'], notices: [] }) })
      .request('/support-bundle', { headers: KEY })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('mgmt-secret-key')
    expect(JSON.parse(text)).toMatchObject({
      jack: { revision: '4ca4a2a' },
      downloads: { configured: false, active: false },
      restartPending: ['downloads'],
      servers: [],
      peers: [],
      keys: [],
    })
  })

  test('POST /diagnostics/folders answers a report', async () => {
    const res = await makeApp().request('/diagnostics/folders', { method: 'POST', headers: KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, sources: [], completed: null })
  })

  test('GET /transfers reports the pauses; pausing needs the config service', async () => {
    const transfersService = new TransfersService(() => undefined, () => null)
    const app = makeApp({ transfersService })
    const snapshot = await (await app.request('/transfers', { headers: KEY })).json() as any
    expect(snapshot.paused).toEqual({ uploads: { paused: false, until: null, indefinite: false }, downloads: { paused: false, until: null, indefinite: false } })
    const res = await app.request('/transfers/pause', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'uploads', until: 'indefinite' }) })
    expect(res.status).toBe(404)
  })

  test('GET /catalog/request-options says downloads are off without a downloads service', async () => {
    const res = await makeApp().request('/catalog/request-options', { headers: KEY })
    expect(await res.json()).toEqual({ servers: [], downloadsActive: false, downloadsInactiveReason: 'off' })
  })

  test('GET /catalog/request-options says a restart is pending when downloads were set up after boot', async () => {
    const configService = { getRawDownloads: () => ({ completedPath: '/data' }), subscribe: () => () => {} } as any
    const pending = await makeApp({ configService }).request('/catalog/request-options', { headers: KEY })
    expect(await pending.json()).toEqual({ servers: [], downloadsActive: false, downloadsInactiveReason: 'restartPending' })

    const downloadsService = { subscribe: () => () => {}, phaseOf: () => null } as any
    const active = await makeApp({ configService, downloadsService }).request('/catalog/request-options', { headers: KEY })
    expect(await active.json()).toEqual({ servers: [], downloadsActive: true, downloadsInactiveReason: null })
  })
})
