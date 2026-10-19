import type { ArrProviderTest, ArrServerConnector } from '../../lib/servers/arr/base'
import type { JackSavedListener, PeerSavedListener, ServerSavedListener } from '../config/config.service'
import type { RegistrationServiceDeps } from './registration.service'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { ConnectorInitializationError } from '../../lib/errors/ConnectorInitializationError'
import { FetchError } from '../../lib/errors/FetchError'
import { ManagedKeysRepository } from '../managed-keys/managed-keys.repository'
import { ManagedApiKeys } from '../managed-keys/managed-keys.service'
import { RegistrationService } from './registration.service'

interface StubCalls {
  clients: Array<{ internalUrl: string }>
  indexers: Array<{ internalUrl: string }>
  inits: number
}

type StubDest = ArrServerConnector & { calls: StubCalls, isInitialized: boolean }

function stubDest(over: Partial<Record<string, unknown>> = {}): StubDest {
  const calls: StubCalls = { clients: [], indexers: [], inits: 0 }
  const ok: ArrProviderTest = { status: 'ok', warnings: [] }
  return {
    id: 'srv-a',
    name: 'Radarr',
    categories: [2000],
    enabled: true,
    canDestination: true,
    isInitialized: true,
    initialization: Promise.resolve(),
    autoRegister: { enable: true, priority: 1 },
    registerDownloadClient: async (config: { internalUrl: string }) => {
      calls.clients.push(config)
      return 7
    },
    registerIndexer: async (config: { internalUrl: string }) => {
      calls.indexers.push(config)
    },
    testDownloadClient: async () => ok,
    testIndexer: async () => ok,
    disableUnboundIndexer: async () => false,
    init() {
      calls.inits++
    },
    calls,
    ...over,
  } as unknown as StubDest
}

function failure(message: string, detail?: string): ArrProviderTest {
  return { status: 'failed', failures: [{ message, ...(detail ? { detail } : {}), warning: false }] }
}

describe('RegistrationService', () => {
  let managedKeys: ManagedApiKeys
  let now: number

  beforeEach(() => {
    const db = drizzle({ client: new Database(':memory:'), schema })
    runMigrations(db)
    managedKeys = new ManagedApiKeys(new ManagedKeysRepository(db))
    now = Date.parse('2026-10-18T10:00:00Z')
  })

  function service(dests: ArrServerConnector[], over: Partial<RegistrationServiceDeps> = {}) {
    return new RegistrationService({
      managedKeys,
      destinations: () => dests,
      internalUrl: () => 'http://jack:5225',
      downloads: () => true,
      downloadsActive: () => true,
      now: () => now,
      ...over,
    })
  }

  test('registers both, has the *arr test both, and keeps the result per destination', async () => {
    const dest = stubDest()
    const registrations = service([dest])
    let notified = 0
    registrations.subscribe(() => notified++)

    const result = (await registrations.register(dest))!

    expect(result).toEqual({
      at: '2026-10-18T10:00:00.000Z',
      indexer: { status: 'ok' },
      downloadClient: { status: 'ok' },
      clientTest: 'ok',
      indexerTest: 'ok',
      message: null,
      testErrors: { downloadClient: null, indexer: null },
    })
    expect(registrations.registration('srv-a')).toEqual(result)
    expect(registrations.registration('other')).toBeNull()
    expect(dest.calls.indexers[0]?.internalUrl).toBe('http://jack:5225/torznab')
    expect(notified).toBe(1)
  })

  test('with downloads off it registers nothing and says why', async () => {
    const dest = stubDest()
    const result = (await service([dest], { downloads: () => false }).register(dest))!

    expect(dest.calls.clients).toHaveLength(0)
    expect(dest.calls.indexers).toHaveLength(0)
    expect(result).toMatchObject({
      indexer: { status: 'skipped', reason: 'downloads-off' },
      downloadClient: { status: 'skipped', reason: 'downloads-off' },
      reason: 'downloads-off',
      clientTest: 'skipped',
      indexerTest: 'skipped',
    })
    expect(result.message).toContain('Turn on Downloads')
  })

  test('skips the client test until a restart starts the qBittorrent API', async () => {
    let clientTests = 0
    const dest = stubDest({
      testDownloadClient: async () => {
        clientTests++
        return { status: 'ok', warnings: [] }
      },
    })
    const result = (await service([dest], { downloadsActive: () => false }).register(dest))!

    expect(clientTests).toBe(0)
    expect(result.downloadClient.status).toBe('ok')
    expect(result.clientTest).toBe('skipped')
    expect(result.indexerTest).toBe('ok')
    expect(result.message).toBe('Restart the jack container so Radarr can use jack\'s download client.')
  })

  test('explains a failed test in plain words and keeps the *arr\'s text', async () => {
    const dest = stubDest({ testDownloadClient: async () => failure('Unable to connect to qBittorrent', 'Name or service not known (jack:5225)') })
    const result = (await service([dest]).register(dest))!

    expect(result.clientTest).toBe('failed')
    expect(result.message).toBe('Radarr can\'t resolve jack. Use your server\'s IP in Address Radarr/Sonarr use to reach jack.')
    expect(result.testErrors.downloadClient).toBe('Unable to connect to qBittorrent (Name or service not known (jack:5225))')
  })

  test('an indexer test with no results counts as reachable', async () => {
    const dest = stubDest({ testIndexer: async () => failure('Query successful, but no results in the configured categories were returned from your indexer.') })
    const result = (await service([dest]).register(dest))!
    expect(result.indexerTest).toBe('ok')
    expect(result.message).toBeNull()
  })

  test('a test the *arr doesn\'t finish in time fails with the address to check', async () => {
    const dest = stubDest({
      testDownloadClient: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
    })
    const result = (await service([dest], { testTimeoutMs: 20_000 }).register(dest))!
    expect(result.clientTest).toBe('failed')
    expect(result.message).toBe('Radarr didn\'t finish testing jack within 20 seconds, so it probably can\'t reach jack:5225. Check Address Radarr/Sonarr use to reach jack.')
  })

  test('a slow indexer test after a passing client test points at friends, not the address', async () => {
    const dest = stubDest({
      testIndexer: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
    })
    const result = (await service([dest], { indexerTestTimeoutMs: 45_000 }).register(dest))!
    expect(result.clientTest).toBe('ok')
    expect(result.indexerTest).toBe('failed')
    expect(result.message).toBe('Radarr reached jack, but the indexer test took longer than 45 seconds. jack waits for friends that don\'t answer, so check the Friends page.')
  })

  test('a failure wins over a skip in the message', async () => {
    const dest = stubDest({ testIndexer: async () => failure('Unable to connect to indexer', 'Connection refused (jack:5225)') })
    const result = (await service([dest], { downloadsActive: () => false }).register(dest))!
    expect(result.clientTest).toBe('skipped')
    expect(result.message).toBe('Radarr reached jack, but nothing answered on jack:5225. Check the port in Address Radarr/Sonarr use to reach jack.')
  })

  test('a failed registration step skips its test', async () => {
    const dest = stubDest({
      registerIndexer: async () => {
        throw new Error('boom')
      },
    })
    const result = (await service([dest]).register(dest))!
    expect(result.indexer).toEqual({ status: 'failed', error: 'boom' })
    expect(result.indexerTest).toBe('skipped')
    expect(result.clientTest).toBe('ok')
  })

  test('reads the internal URL at the start of every registration', async () => {
    const dest = stubDest()
    let url = 'http://jack:5225'
    const registrations = service([dest], { internalUrl: () => url })
    await registrations.register(dest)
    url = 'http://192.168.1.10:5225'
    await registrations.register(dest)
    expect(dest.calls.clients.map(c => c.internalUrl)).toEqual(['http://jack:5225', 'http://192.168.1.10:5225'])
  })

  test('runs one registration at a time, and a queued duplicate joins the queued one', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const a = stubDest({
      registerDownloadClient: async () => {
        order.push('a:start')
        await gate
        order.push('a:end')
        return 1
      },
    })
    const b = stubDest({
      id: 'srv-b',
      registerDownloadClient: async () => {
        order.push('b:start')
        return 2
      },
    })
    const registrations = service([a, b])

    const first = registrations.register(a)
    const second = registrations.register(b)
    const duplicate = registrations.register(b)
    await Bun.sleep(5)
    expect(order).toEqual(['a:start'])
    release()
    await Promise.all([first, second])

    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
    expect(await duplicate).toBe(await second)
  })

  test('records the last contact and tells subscribers about it once a minute while the *arr polls', () => {
    const registrations = service([])
    let notified = 0
    registrations.subscribe(() => notified++)

    expect(registrations.lastContactAt('srv-a')).toBeNull()
    // Radarr polling every 30 s: the minute counts from the last notification,
    // not from the last contact.
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      registrations.recordContact('srv-a')
      seen.push(notified)
      now += 30_000
    }
    expect(seen).toEqual([1, 1, 2, 2, 3])
    expect(registrations.lastContactAt('srv-a')).toBe('2026-10-18T10:02:00.000Z')

    registrations.recordContact('srv-b')
    expect(notified).toBe(4)
  })

  test('registers a destination that comes online after boot, once', async () => {
    const dest = stubDest({ isInitialized: false })
    const registrations = service([dest])
    await registrations.registerAll()
    expect(dest.calls.clients).toHaveLength(0)

    dest.isInitialized = true
    registrations.registerNewlyInitialized()
    registrations.registerNewlyInitialized()
    await Bun.sleep(5)
    expect(dest.calls.clients).toHaveLength(1)
    expect(registrations.registration('srv-a')?.downloadClient.status).toBe('ok')
  })

  test('leaves alone a destination registered by a save', async () => {
    const dest = stubDest()
    const registrations = service([dest])
    await registrations.register(dest)
    registrations.registerNewlyInitialized()
    await Bun.sleep(1)
    expect(dest.calls.clients).toHaveLength(1)
  })

  test('retries connecting to a destination that is down, with backoff', () => {
    const dest = stubDest({ isInitialized: false })
    const registrations = service([dest])
    const start = now
    for (const offset of [0, 10_000, 30_000, 60_000, 90_000])
      registrations.retryUninitialized(start + offset)
    // 0, then +30 s, then +60 s after that.
    expect(dest.calls.inits).toBe(3)

    const manual = stubDest({ isInitialized: false, autoRegister: { enable: false, priority: 1 } })
    service([manual]).retryUninitialized(start)
    expect(manual.calls.inits).toBe(0)
  })

  test('ensureRegistrable refuses servers jack doesn\'t register in, and one it can\'t reach', async () => {
    const registrations = service([])
    await expect(registrations.ensureRegistrable(stubDest({ canDestination: false }))).rejects.toBeInstanceOf(BadRequestError)
    await expect(registrations.ensureRegistrable(stubDest({ autoRegister: { enable: false, priority: 1 } }))).rejects.toBeInstanceOf(BadRequestError)

    const down = Promise.reject(new Error('connection refused'))
    down.catch(() => {})
    await expect(registrations.ensureRegistrable(stubDest({ isInitialized: false, initialization: down }))).rejects.toBeInstanceOf(ConnectorInitializationError)

    const late = stubDest({ isInitialized: false })
    await registrations.ensureRegistrable(late)
    expect(late.calls.inits).toBe(1)
  })

  test('a queued run leaves alone a server that stopped auto-registering while it waited', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = stubDest({
      registerDownloadClient: async () => {
        await gate
        return 1
      },
    })
    const b = stubDest({ id: 'srv-b', name: 'Sonarr' })
    const registrations = service([a, b])

    const first = registrations.register(a)
    const queued = registrations.register(b)
    await Bun.sleep(1)
    b.autoRegister.enable = false
    release()
    await first

    expect(await queued).toBeNull()
    expect(b.calls.clients).toHaveLength(0)
    expect(b.calls.indexers).toHaveLength(0)
    expect(registrations.registration('srv-b')).toBeNull()
  })

  test('a queued run uses the connector that replaced the one it was queued with', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = stubDest({
      registerDownloadClient: async () => {
        await gate
        return 1
      },
    })
    const removed = stubDest({ id: 'srv-c' })
    const old = stubDest({ id: 'srv-b' })
    const replacement = stubDest({ id: 'srv-b', autoRegister: { enable: true, priority: 25 } })
    const dests = [a, old, removed]
    const registrations = service(dests)

    const first = registrations.register(a)
    const queued = registrations.register(old)
    const gone = registrations.register(removed)
    await Bun.sleep(1)
    dests.splice(1, 2, replacement)
    // A save of the new connector joins the queued run.
    const again = registrations.register(replacement)
    release()
    await first

    expect(await again).toBe(await queued)
    expect(await gone).toBeNull()
    expect(old.calls.clients).toHaveLength(0)
    expect(removed.calls.clients).toHaveLength(0)
    expect(replacement.calls.clients).toHaveLength(1)
    expect((replacement.calls.indexers[0] as unknown as { priority: number }).priority).toBe(25)
  })

  test('start registers a destination that comes online once, however often the connectors change', async () => {
    const dest = stubDest({ isInitialized: false })
    const saved = stubDest({ id: 'srv-b' })
    const registrations = service([dest, saved])
    const subscribers = new Set<() => void>()
    let unsubscribed = 0
    registrations.start((subscriber) => {
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
        unsubscribed++
      }
    }, { debounceMs: 5, retryIntervalMs: 60_000 })
    const fire = () => {
      for (const subscriber of subscribers)
        subscriber()
    }

    try {
      // A server saved in the UI is registered by its save, not by the late check.
      await registrations.register(saved)
      dest.isInitialized = true
      fire()
      fire()
      fire()
      await Bun.sleep(20)
      fire()
      await Bun.sleep(20)

      expect(dest.calls.clients).toHaveLength(1)
      expect(saved.calls.clients).toHaveLength(1)
    }
    finally {
      registrations.stop()
    }
    expect(unsubscribed).toBe(1)
    expect(subscribers.size).toBe(0)
  })

  test('with downloads off it says so when it turned off an old unbound indexer', async () => {
    const dest = stubDest({ disableUnboundIndexer: async () => true })
    const result = (await service([dest], { downloads: () => false }).register(dest))!
    expect(result.indexer).toEqual({ status: 'skipped', reason: 'downloads-off', disabledUnbound: true })
    expect(result.message).toBe('Downloads are off, so jack didn\'t add itself to Radarr, and it turned off the Jack indexer it had added there before, which had no download client. Turn on Downloads in Settings.')
  })

  test('a refused download client leaves the indexer alone and says so', async () => {
    const dest = stubDest({
      registerDownloadClient: async () => {
        throw new Error('Unauthorized')
      },
    })
    const result = (await service([dest]).register(dest))!
    expect(dest.calls.indexers).toHaveLength(0)
    expect(result).toMatchObject({
      downloadClient: { status: 'failed', error: 'Unauthorized' },
      indexer: { status: 'skipped', reason: 'client-failed' },
      clientTest: 'skipped',
      indexerTest: 'skipped',
      message: 'jack couldn\'t add its download client to Radarr (Unauthorized), so it left the indexer as it was. Register again.',
    })
  })

  test('follows config saves: a server, a new internal URL, downloads turned on', async () => {
    const dest = stubDest()
    const registrations = service([dest])
    const listeners: { server?: ServerSavedListener, jack?: JackSavedListener, downloads?: (previous: unknown) => void } = {}
    registrations.followConfig({
      onServerSaved: (l) => {
        listeners.server = l
        return () => {}
      },
      onJackSaved: (l) => {
        listeners.jack = l
        return () => {}
      },
      onDownloadsSaved: (l) => {
        listeners.downloads = l as (previous: unknown) => void
        return () => {}
      },
      onPeerSaved: () => () => {},
    })

    expect((await listeners.server!('srv-a'))?.downloadClient.status).toBe('ok')
    expect(await listeners.server!('unknown')).toBeNull()

    listeners.jack!({ internalUrl: 'http://jack:5225' }, { internalUrl: 'http://jack:5225' })
    listeners.downloads!({ completedPath: '/data/jack' })
    await registrations.registerAll()
    expect(dest.calls.clients).toHaveLength(2)

    // Both queue a registration of the same server; the second joins the first.
    listeners.jack!({ internalUrl: 'http://jack:5225' }, { internalUrl: 'http://192.168.1.10:5225' })
    listeners.downloads!(null)
    await Bun.sleep(5)
    expect(dest.calls.clients).toHaveLength(3)
  })

  test('an indexer the *arr refuses for an empty feed says so in plain words', async () => {
    const body = JSON.stringify([{ errorMessage: 'Query successful, but no results in the configured categories were returned from your indexer.', severity: 'error', isWarning: false }])
    const dest = stubDest({
      registerIndexer: async () => {
        throw new FetchError('Failed to fetch url: Bad Request', new Response(body, { status: 400 }), { body })
      },
    })
    const result = (await service([dest]).register(dest))!
    expect(result.indexer).toEqual({ status: 'failed', error: 'Query successful, but no results in the configured categories were returned from your indexer.' })
    expect(result.message).toBe('Radarr won\'t add jack\'s indexer until your friends have something to share. jack tries again when you add or save a friend.')
  })

  test('a saved friend registers again where the indexer step failed, and only there', async () => {
    let refuse = true
    let attempts = 0
    const failing = stubDest({
      registerIndexer: async () => {
        attempts++
        if (refuse)
          throw new Error('no results')
      },
    })
    const fine = stubDest({ id: 'srv-b', name: 'Sonarr' })
    const registrations = service([failing, fine])
    let peerSaved!: PeerSavedListener
    registrations.followConfig({
      onServerSaved: () => () => {},
      onJackSaved: () => () => {},
      onDownloadsSaved: () => () => {},
      onPeerSaved: (l) => {
        peerSaved = l
        return () => {}
      },
    })
    await registrations.registerAll()
    expect(registrations.registration('srv-a')?.indexer.status).toBe('failed')
    let notified = 0
    registrations.subscribe(() => notified++)

    refuse = false
    peerSaved('peer-1', null)
    await Bun.sleep(10)

    expect(attempts).toBe(2)
    expect(fine.calls.indexers).toHaveLength(1)
    expect(registrations.registration('srv-a')).toMatchObject({ indexer: { status: 'ok' }, indexerTest: 'ok', message: null })
    expect(notified).toBe(1)

    // Nothing failed now, so the next friend changes nothing.
    peerSaved('peer-2', null)
    await Bun.sleep(10)
    expect(attempts).toBe(2)
  })

  test('a friend saved while a registration runs counts with that registration\'s result', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let attempts = 0
    const dest = stubDest({
      registerIndexer: async () => {
        attempts++
        if (attempts === 1) {
          await gate
          throw new Error('no results')
        }
      },
    })
    const registrations = service([dest])

    const first = registrations.register(dest)
    await Bun.sleep(1)
    const again = registrations.registerFailedIndexers()
    release()

    expect((await first)?.indexer.status).toBe('failed')
    const results = await again
    expect(attempts).toBe(2)
    expect(results.map(result => result?.indexer.status)).toEqual(['ok'])
  })

  test('registerFailedIndexers leaves alone a destination that is down or no longer auto-registers', async () => {
    let attempts = 0
    const dest = stubDest({
      registerIndexer: async () => {
        attempts++
        throw new Error('no results')
      },
    })
    const registrations = service([dest])
    await registrations.register(dest)

    dest.isInitialized = false
    expect(await registrations.registerFailedIndexers()).toEqual([])
    dest.isInitialized = true
    Object.assign(dest, { autoRegister: { enable: false, priority: 1 } })
    expect(await registrations.registerFailedIndexers()).toEqual([])
    expect(attempts).toBe(1)
  })
})
