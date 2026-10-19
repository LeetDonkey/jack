import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { pausedInHealth } from '../../lib/servers/arr/base'
import { RadarrServerConnector } from '../../lib/servers/arr/radarr'
import { SonarrServerConnector } from '../../lib/servers/arr/sonarr'
import { ManagedKeysRepository } from '../managed-keys/managed-keys.repository'
import { ManagedApiKeys } from '../managed-keys/managed-keys.service'
import { RegistrationService } from './registration.service'

const MASK = '********'
const MINUTE = 60_000
// Radarr 6 and Sonarr 4 send the wiki link as a string.
const WIKI = 'https://wiki.servarr.com/radarr/system#indexers-are-unavailable-due-to-failures'
// Servarr's backoff per escalation level (EscalationBackOff.Periods), in seconds.
const BACKOFF_S = [0, 60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400]
const NO_RESULTS = {
  propertyName: '',
  errorMessage: 'Query successful, but no results in the configured categories were returned from your indexer. This may be an issue with the indexer or your indexer category settings.',
  severity: 'error',
  isWarning: false,
}

interface ProviderStatus {
  level: number
  initialFailure: number
  mostRecentFailure: number
  disabledTill: number | null
}

/**
 * A Radarr/Sonarr with the indexer status rules measured on Radarr 6.4.4 and
 * Sonarr 4.0.20 (ProviderStatusServiceBase, IndexerFactory.Test):
 * - a test of a saved indexer (id > 0) records its result; a test of id 0
 *   records nothing;
 * - a failure starts a pause of 1 minute (level 1); each further failure goes
 *   one level up (5, 15, 30 minutes, 1, 3, 6, 12, 24 hours), except in the first
 *   15 minutes after the *arr started, when the level stays and a pause is at
 *   most 5 minutes;
 * - a pass goes one level down and ends the pause;
 * - names are unique (a copy with id 0 named like the saved one is refused);
 * - a copy can't fill in the masked key, only the saved entry can;
 * - there is no indexer status route; the health check names paused indexers.
 */
function fakeArr(baseUrl: string, clock: { now: number }) {
  const state = {
    startedAt: clock.now,
    feed: 'empty' as 'empty' | 'releases',
    indexers: [] as any[],
    clients: [] as any[],
    status: new Map<number, ProviderStatus>(),
    tests: [] as Array<{ id: number, status: number }>,
  }
  let nextId = 1

  const masked = (resource: any, secret: string) => ({
    ...resource,
    fields: resource.fields.map((f: any) => f.name === secret ? { ...f, value: MASK } : f),
  })
  const secretOf = (resource: any, secret: string) => resource.fields.find((f: any) => f.name === secret)?.value
  const enabled = (idx: any) => Boolean(idx.enableRss || idx.enableAutomaticSearch || idx.enableInteractiveSearch)
  // Keep the stored secret when the body sends the mask back.
  const merge = (body: any, saved: any, secret: string) => secretOf(body, secret) === MASK
    ? { ...body, fields: body.fields.map((f: any) => f.name === secret ? { ...f, value: secretOf(saved, secret) } : f) }
    : body

  function recordFailure(id: number) {
    const s = state.status.get(id) ?? { level: 0, initialFailure: 0, mostRecentFailure: 0, disabledTill: null }
    const now = clock.now
    let escalate = true
    s.mostRecentFailure = now
    if (s.level === 0) {
      s.initialFailure = now
      s.level = 1
      escalate = false
    }
    const inStartupGrace = state.startedAt + 15 * MINUTE > now
    if (escalate && !inStartupGrace)
      s.level = Math.min(BACKOFF_S.length - 1, s.level + 1)
    s.disabledTill = now + BACKOFF_S[s.level]! * 1000
    if (inStartupGrace)
      s.disabledTill = Math.min(s.disabledTill, now + 5 * MINUTE)
    state.status.set(id, s)
  }

  function recordSuccess(id: number) {
    const s = state.status.get(id)
    if (!s || s.level === 0)
      return
    s.level--
    s.disabledTill = null
  }

  // The Torznab test: jack's feed answers with the key the indexer holds.
  function feedFailures(indexer: any): unknown[] {
    const key = secretOf(indexer, 'apiKey')
    if (!key || key === MASK)
      return [{ propertyName: 'ApiKey', errorMessage: 'Invalid API key', severity: 'error', isWarning: false }]
    return state.feed === 'empty' ? [NO_RESULTS] : []
  }

  const paused = (id: number) => (state.status.get(id)?.disabledTill ?? 0) > clock.now

  const handlers = [
    http.get(`${baseUrl}/api/v3/indexer`, () => HttpResponse.json(state.indexers.map(idx => masked(idx, 'apiKey')))),
    http.post(`${baseUrl}/api/v3/indexer/test`, async ({ request }) => {
      const body = await request.json() as any
      const id = Number(body.id ?? 0)
      if (state.indexers.some(idx => idx.name.toLowerCase() === String(body.name).toLowerCase() && idx.id !== id))
        return HttpResponse.json([{ propertyName: 'Name', errorMessage: 'Should be unique', severity: 'error', isWarning: false }], { status: 400 })
      const saved = id > 0 ? state.indexers.find(idx => idx.id === id) : undefined
      const failures = feedFailures(saved ? merge(body, saved, 'apiKey') : body)
      if (saved) {
        if (failures.length > 0)
          recordFailure(id)
        else
          recordSuccess(id)
      }
      state.tests.push({ id, status: failures.length > 0 ? 400 : 200 })
      return failures.length > 0 ? HttpResponse.json(failures as any, { status: 400 }) : new HttpResponse(null, { status: 200 })
    }),
    http.post(`${baseUrl}/api/v3/indexer`, async ({ request }) => {
      const body = await request.json() as any
      // forceSave skips warnings only, and a switched-off indexer isn't tested.
      if (enabled(body) && feedFailures(body).length > 0)
        return HttpResponse.json(feedFailures(body) as any, { status: 400 })
      const created = { ...body, id: nextId++ }
      state.indexers.push(created)
      return HttpResponse.json(masked(created, 'apiKey'), { status: 201 })
    }),
    http.put(`${baseUrl}/api/v3/indexer/:id`, async ({ request, params }) => {
      const body = await request.json() as any
      const id = Number(params.id)
      const saved = state.indexers.find(idx => idx.id === id)
      const next = merge({ ...body, id }, saved, 'apiKey')
      state.indexers = state.indexers.map(idx => idx.id === id ? next : idx)
      return HttpResponse.json(masked(next, 'apiKey'), { status: 202 })
    }),
    http.get(`${baseUrl}/api/v3/downloadclient`, () => HttpResponse.json(state.clients.map(c => masked(c, 'password')))),
    http.post(`${baseUrl}/api/v3/downloadclient/test`, () => new HttpResponse(null, { status: 200 })),
    http.post(`${baseUrl}/api/v3/downloadclient`, async ({ request }) => {
      const created = { ...(await request.json() as any), id: nextId++ }
      state.clients.push(created)
      return HttpResponse.json(masked(created, 'password'), { status: 201 })
    }),
    http.put(`${baseUrl}/api/v3/downloadclient/:id`, async ({ request, params }) => {
      const id = Number(params.id)
      const body = await request.json() as any
      state.clients = state.clients.map(c => c.id === id ? merge({ ...body, id }, c, 'password') : c)
      return HttpResponse.json(body, { status: 202 })
    }),
    http.get(`${baseUrl}/api/v3/indexerstatus`, () => new HttpResponse(null, { status: 404 })),
    http.get(`${baseUrl}/api/v3/health`, () => {
      const available = state.indexers.filter(enabled)
      const blocked = available.filter(idx => paused(idx.id))
      const recent = blocked.filter(idx => state.status.get(idx.id)!.initialFailure > clock.now - 6 * 60 * MINUTE)
      const issues: unknown[] = [{ source: 'UpdateCheck', type: 'notice', message: 'New update is available: Jack', wikiUrl: WIKI }]
      if (recent.length > 0) {
        issues.push(recent.length === available.length
          ? { source: 'IndexerStatusCheck', type: 'error', message: 'All indexers are unavailable due to failures', wikiUrl: WIKI }
          : { source: 'IndexerStatusCheck', type: 'warning', message: `Indexers unavailable due to failures: ${recent.map(idx => idx.name).join(', ')}`, wikiUrl: WIKI })
      }
      return HttpResponse.json(issues)
    }),
  ]
  return { state, handlers, paused }
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

const options = { apiKey: 'a'.repeat(32), source: false, destination: true, autoregister: { enable: true, priority: 50 } }
const apps = [
  { app: 'Radarr', url: 'http://radarr-status.test:7878', make: (url: string) => initialized(new RadarrServerConnector({ ...options, url, name: 'Radarr' })) },
  { app: 'Sonarr', url: 'http://sonarr-status.test:8989', make: (url: string) => initialized(new SonarrServerConnector({ ...options, url, name: 'Sonarr' })) },
]

for (const { app, url, make } of apps) {
  describe(`${app} indexer status with jack's tests`, () => {
    const clock = { now: Date.parse('2026-10-19T12:00:00Z') }
    let arr: ReturnType<typeof fakeArr>
    let dest: ArrServerConnector
    let registrations: RegistrationService
    const torznab = 'http://jack:5225/torznab'

    beforeEach(() => {
      clock.now = Date.parse('2026-10-19T12:00:00Z')
      arr = fakeArr(url, clock)
      server.use(...arr.handlers)
      dest = make(url)
      const db = drizzle({ client: new Database(':memory:'), schema })
      runMigrations(db)
      registrations = new RegistrationService({
        managedKeys: new ManagedApiKeys(new ManagedKeysRepository(db)),
        destinations: () => [dest],
        internalUrl: () => 'http://jack:5225',
        downloads: () => true,
        downloadsActive: () => true,
        now: () => clock.now,
        clientRetryDelayMs: 0,
      })
    })

    const jackId = () => arr.state.indexers.find(idx => idx.name === 'Jack')!.id

    test('registering with an empty feed records nothing, however often; the old test of the saved indexer pauses it longer each time', async () => {
      for (let boot = 0; boot < 4; boot++) {
        const result = (await registrations.register(dest))!
        expect(result).toMatchObject({ indexer: { status: 'ok' }, indexerTest: 'ok', message: null, indexerPausedUntil: null })
        clock.now += 20 * MINUTE
      }
      expect(arr.state.status.get(jackId())).toBeUndefined()
      expect(arr.state.tests.every(t => t.id === 0)).toBe(true)

      // What jack did before: test the saved indexer, after the *arr's first 15 minutes.
      const pauses: number[] = []
      for (let i = 0; i < 4; i++) {
        await dest.testIndexer('Jack', torznab)
        pauses.push((arr.state.status.get(jackId())!.disabledTill! - clock.now) / MINUTE)
        clock.now += MINUTE
      }
      expect(pauses).toEqual([1, 5, 15, 30])
      expect(await dest.isIndexerPaused('Jack', torznab)).toBe(true)
    })

    test('a registration ends a pause once the feed has releases', async () => {
      await registrations.register(dest)
      arr.state.status.set(jackId(), { level: 4, initialFailure: clock.now - MINUTE, mostRecentFailure: clock.now - MINUTE, disabledTill: clock.now + 29 * MINUTE })
      arr.state.feed = 'releases'

      const result = (await registrations.register(dest))!

      expect(arr.state.status.get(jackId())).toMatchObject({ level: 3, disabledTill: null })
      expect(arr.paused(jackId())).toBe(false)
      expect(result).toMatchObject({ indexerTest: 'ok', message: null })
    })

    test('with an empty feed a pause stays as it was, jack says so, and a friend with releases ends it', async () => {
      await registrations.register(dest)
      const before = { level: 4, initialFailure: clock.now - MINUTE, mostRecentFailure: clock.now - MINUTE, disabledTill: clock.now + 29 * MINUTE }
      arr.state.status.set(jackId(), { ...before })

      const result = (await registrations.register(dest))!
      expect(arr.state.status.get(jackId())).toEqual(before)
      expect(result).toMatchObject({ indexerPaused: true, message: null })

      arr.state.feed = 'releases'
      const [again] = await registrations.registerAfterFriendChange()
      expect(arr.paused(jackId())).toBe(false)
      expect(again?.message).toBeNull()
    })

    test('while the pause lasts jack tests the feed every 30 minutes with the same key, and ends the pause once the feed has releases', async () => {
      const indexerKey = () => arr.state.indexers.find(idx => idx.name === 'Jack')!.fields.find((f: any) => f.name === 'apiKey')!.value
      await registrations.register(dest)
      arr.state.status.set(jackId(), { level: 6, initialFailure: clock.now - MINUTE, mostRecentFailure: clock.now - MINUTE, disabledTill: clock.now + 3 * 60 * MINUTE })
      expect(await registrations.register(dest)).toMatchObject({ indexerPaused: true, indexerPausedUntil: null })
      const key = indexerKey()
      const tests = arr.state.tests.length

      // Within 30 minutes of the registration's test: only the pause check.
      clock.now += 10 * MINUTE
      await registrations.refreshPauses()
      expect(arr.state.tests).toHaveLength(tests)

      clock.now += 25 * MINUTE
      await registrations.refreshPauses()
      expect(arr.state.tests.slice(tests)).toEqual([{ id: 0, status: 400 }])
      expect(arr.paused(jackId())).toBe(true)

      arr.state.feed = 'releases'
      clock.now += 30 * MINUTE
      await registrations.refreshPauses()
      expect(arr.state.tests.slice(tests)).toEqual([{ id: 0, status: 400 }, { id: 0, status: 200 }, { id: jackId(), status: 200 }])
      expect(arr.paused(jackId())).toBe(false)
      expect(registrations.registration(dest.id)).toMatchObject({ indexerPaused: false, message: null })
      expect(indexerKey()).toBe(key)
    })

    test('the copy jack tests needs the key it just gave the indexer', async () => {
      arr.state.feed = 'releases'
      await registrations.register(dest)
      // Without a key the copy would hold only the mask.
      expect(await dest.testIndexer('Jack', torznab, { apiKey: MASK })).toMatchObject({ status: 'failed' })
      expect(arr.state.status.get(jackId())).toBeUndefined()
    })
  })
}

describe('pausedInHealth', () => {
  const warning = (names: string) => ({ source: 'IndexerStatusCheck', type: 'warning', message: `Indexers unavailable due to failures: ${names}` })

  test('finds jack\'s indexer by its exact name in the list', () => {
    expect(pausedInHealth([warning('Jack')], 'Jack')).toBe(true)
    expect(pausedInHealth([warning('1337x, Jack')], 'Jack')).toBe(true)
    expect(pausedInHealth([warning('Jackett, 1337x (Jackett)')], 'Jack')).toBe(false)
    expect(pausedInHealth([{ ...warning('Jack'), source: 'IndexerLongTermStatusCheck' }], 'Jack')).toBe(true)
  })

  test('every enabled indexer paused counts, other checks don\'t', () => {
    expect(pausedInHealth([{ source: 'IndexerStatusCheck', type: 'error', message: 'All indexers are unavailable due to failures' }], 'Jack')).toBe(true)
    expect(pausedInHealth([{ source: 'IndexerRssCheck', type: 'warning', message: 'All rss-capable indexers are temporarily unavailable due to recent indexer errors' }], 'Jack')).toBe(false)
    expect(pausedInHealth([], 'Jack')).toBe(false)
  })
})
