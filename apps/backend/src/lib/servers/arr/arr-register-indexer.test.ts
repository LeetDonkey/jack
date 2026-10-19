import type { ArrServerConnector } from './base'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { RadarrServerConnector } from './radarr'
import { SonarrServerConnector } from './sonarr'

const RADARR_URL = 'http://radarr-indexer.test:7878'
const SONARR_URL = 'http://sonarr-indexer.test:8989'

// Radarr 6.4 and Sonarr 4.0 answer this when their test of jack's feed finds nothing.
const NO_RESULTS = {
  propertyName: '',
  errorMessage: 'Query successful, but no results in the configured categories were returned from your indexer. This may be an issue with the indexer or your indexer category settings.',
  severity: 'error',
  isWarning: false,
}

interface ArrCall {
  method: string
  path: string
  forceSave: string | null
  enabled?: boolean
  status: number
}

/**
 * A Radarr/Sonarr indexer API with Servarr's save rules, as measured on Radarr
 * 6.4.4 and Sonarr 4.0.20: a create tests an enabled indexer, and forceSave only
 * drops warnings; an update with forceSave isn't tested; a disabled indexer
 * isn't tested.
 */
function fakeArr(baseUrl: string) {
  const state = {
    indexers: [] as any[],
    calls: [] as ArrCall[],
    // What the *arr's test of the indexer finds wrong; [] passes.
    testFailures: [NO_RESULTS] as unknown[],
  }
  let nextId = 1
  const enabled = (body: any) => Boolean(body.enableRss || body.enableAutomaticSearch || body.enableInteractiveSearch)
  const testFails = (body: any, includeWarnings: boolean) => enabled(body)
    && state.testFailures.some((f: any) => includeWarnings || !f.isWarning)

  const handlers = [
    http.get(`${baseUrl}/api/v3/indexer`, () => HttpResponse.json(state.indexers)),
    http.post(`${baseUrl}/api/v3/indexer`, async ({ request }) => {
      const url = new URL(request.url)
      const body = await request.json() as any
      const forceSave = url.searchParams.get('forceSave')
      if (testFails(body, forceSave !== 'true')) {
        state.calls.push({ method: 'POST', path: url.pathname, forceSave, enabled: enabled(body), status: 400 })
        return HttpResponse.json(state.testFailures as any, { status: 400 })
      }
      const created = { ...body, id: nextId++ }
      state.indexers.push(created)
      state.calls.push({ method: 'POST', path: url.pathname, forceSave, enabled: enabled(body), status: 201 })
      return HttpResponse.json(created, { status: 201 })
    }),
    http.put(`${baseUrl}/api/v3/indexer/:id`, async ({ request, params }) => {
      const url = new URL(request.url)
      const body = await request.json() as any
      const forceSave = url.searchParams.get('forceSave')
      if (forceSave !== 'true' && testFails(body, true)) {
        state.calls.push({ method: 'PUT', path: url.pathname, forceSave, enabled: enabled(body), status: 400 })
        return HttpResponse.json(state.testFailures as any, { status: 400 })
      }
      state.indexers = state.indexers.map(idx => (String(idx.id) === String(params.id) ? body : idx))
      state.calls.push({ method: 'PUT', path: url.pathname, forceSave, enabled: enabled(body), status: 202 })
      return HttpResponse.json(body, { status: 202 })
    }),
  ]
  return { state, handlers }
}

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function initialized<T extends ArrServerConnector>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return connector
}

const options = { apiKey: 'a'.repeat(32), source: false, destination: true, autoregister: { enable: true, priority: 25 } }
const apps = [
  { app: 'Radarr', url: RADARR_URL, make: () => initialized(new RadarrServerConnector({ ...options, url: RADARR_URL, name: 'Radarr' })) },
  { app: 'Sonarr', url: SONARR_URL, make: () => initialized(new SonarrServerConnector({ ...options, url: SONARR_URL, name: 'Sonarr' })) },
]

for (const { app, url, make } of apps) {
  describe(`${app} registerIndexer with an empty feed`, () => {
    let arr: ReturnType<typeof fakeArr>
    let connector: ArrServerConnector
    const register = (priority = 25) => connector.registerIndexer({
      name: 'Jack',
      internalUrl: 'http://jack:5225/torznab',
      apiKey: 'managed-key',
      priority,
      categories: connector.categories,
      downloadClientId: 3,
    })

    beforeEach(() => {
      arr = fakeArr(url)
      server.use(...arr.handlers)
      connector = make()
    })

    test('adds the indexer switched off, then switches it on, so it ends up enabled', async () => {
      await register()

      expect(arr.state.calls).toEqual([
        { method: 'POST', path: '/api/v3/indexer', forceSave: 'true', enabled: true, status: 400 },
        { method: 'POST', path: '/api/v3/indexer', forceSave: 'true', enabled: false, status: 201 },
        { method: 'PUT', path: '/api/v3/indexer/1', forceSave: 'true', enabled: true, status: 202 },
      ])
      expect(arr.state.indexers).toHaveLength(1)
      expect(arr.state.indexers[0]).toMatchObject({
        id: 1,
        name: 'Jack',
        enableRss: true,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: 25,
        downloadClientId: 3,
      })
      expect(arr.state.indexers[0].fields).toContainEqual({ name: 'apiKey', value: 'managed-key' })
    })

    test('registering again updates the indexer in place without a test', async () => {
      await register()
      arr.state.calls = []

      await register(10)

      expect(arr.state.calls).toEqual([
        { method: 'PUT', path: '/api/v3/indexer/1', forceSave: 'true', enabled: true, status: 202 },
      ])
      expect(arr.state.indexers).toHaveLength(1)
      expect(arr.state.indexers[0]).toMatchObject({ enableRss: true, priority: 10 })
    })

    test('a feed with results is added in one call', async () => {
      arr.state.testFailures = []
      await register()
      expect(arr.state.calls).toEqual([
        { method: 'POST', path: '/api/v3/indexer', forceSave: 'true', enabled: true, status: 201 },
      ])
    })

    test('any other test error fails the step, with nothing added', async () => {
      arr.state.testFailures = [{ propertyName: 'BaseUrl', errorMessage: 'Unable to connect to indexer', severity: 'error', isWarning: false }]
      await expect(register()).rejects.toThrow()
      arr.state.testFailures = [NO_RESULTS, { propertyName: 'ApiKey', errorMessage: 'Invalid API key', severity: 'error', isWarning: false }]
      await expect(register()).rejects.toThrow()

      expect(arr.state.calls.map(call => call.status)).toEqual([400, 400])
      expect(arr.state.indexers).toEqual([])
    })
  })
}
