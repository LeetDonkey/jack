import type { ManagedRegistrationDeps } from './autoregister'
import type { ArrServerConnector } from './servers/arr/base'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { ManagedKeysRepository } from '../modules/managed-keys/managed-keys.repository'
import { ManagedApiKeys } from '../modules/managed-keys/managed-keys.service'
import { registerManagedForDestination } from './autoregister'

describe('registerManagedForDestination', () => {
  let repo: ManagedKeysRepository
  let service: ManagedApiKeys

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    repo = new ManagedKeysRepository(db)
    service = new ManagedApiKeys(repo)
  })

  function stubDest(over: Partial<{ registerIndexer: () => Promise<void>, registerDownloadClient: () => Promise<number>, disableUnboundIndexer: (name: string, baseUrl: string) => Promise<boolean> }> = {}): ArrServerConnector {
    return {
      id: 'srv-a',
      name: 'Radarr',
      categories: [2000],
      autoRegister: { enable: true, priority: 1 },
      registerDownloadClient: over.registerDownloadClient ?? (async () => 1),
      registerIndexer: over.registerIndexer ?? (async () => {}),
      disableUnboundIndexer: over.disableUnboundIndexer ?? (async () => false),
    } as unknown as ArrServerConnector
  }

  function deps(): ManagedRegistrationDeps {
    return {
      managedKeys: service,
      internalUrl: 'http://jack:5225',
      downloads: true,
      category: 'jack-srv-a',
      onSuccess: () => {},
      onFailure: () => {},
    }
  }

  test('full success commits — only the new key remains', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(stubDest(), deps())
    const rows = repo.findByServerId('srv-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).not.toBe(old.id)
  })

  test('partial failure (indexer fails) keeps both old and new keys', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(
      stubDest({ registerIndexer: async () => { throw new Error('boom') } }),
      deps(),
    )
    const ids = repo.findByServerId('srv-a').map(r => r.id)
    expect(ids).toContain(old.id)
    expect(ids).toHaveLength(2)
  })

  test('a failed download client leaves the indexer alone and discards the new key', async () => {
    const old = service.provision('srv-a')
    const calls: string[] = []
    const outcome = await registerManagedForDestination(
      stubDest({
        registerDownloadClient: async () => { throw new Error('dc') },
        registerIndexer: async () => { calls.push('indexer') },
      }),
      deps(),
    )
    // Registering the indexer without a client id would reset its binding to "Any".
    expect(calls).toEqual([])
    expect(outcome).toEqual({
      downloadClient: { status: 'failed', error: 'dc' },
      indexer: { status: 'skipped', reason: 'client-failed' },
    })
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([old.id])
  })

  test('total failure discards the new key (only the old remains)', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(
      stubDest({
        registerDownloadClient: async () => { throw new Error('dc') },
        registerIndexer: async () => { throw new Error('ix') },
      }),
      deps(),
    )
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([old.id])
  })

  test('full success reports both steps ok', async () => {
    const outcome = await registerManagedForDestination(stubDest(), deps())
    expect(outcome).toEqual({ indexer: { status: 'ok' }, downloadClient: { status: 'ok' } })
  })

  test('a failed step reports what *arr said', async () => {
    const outcome = await registerManagedForDestination(
      stubDest({ registerIndexer: async () => { throw new Error('boom') } }),
      deps(),
    )
    expect(outcome).toEqual({ indexer: { status: 'failed', error: 'boom' }, downloadClient: { status: 'ok' } })
  })

  test('downloads off registers nothing, not even an unbound indexer, and keeps the old key', async () => {
    const old = service.provision('srv-a')
    const calls: string[] = []
    const outcome = await registerManagedForDestination(
      stubDest({
        registerIndexer: async () => { calls.push('indexer') },
        registerDownloadClient: async () => {
          calls.push('client')
          return 1
        },
      }),
      { ...deps(), downloads: false },
    )
    expect(calls).toEqual([])
    expect(outcome).toEqual({
      indexer: { status: 'skipped', reason: 'downloads-off' },
      downloadClient: { status: 'skipped', reason: 'downloads-off' },
      reason: 'downloads-off',
    })
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([old.id])
  })

  test('downloads off turns off an unbound Jack indexer an earlier jack left behind', async () => {
    const checked: string[] = []
    const outcome = await registerManagedForDestination(
      stubDest({
        disableUnboundIndexer: async (name, baseUrl) => {
          checked.push(`${name} ${baseUrl}`)
          return true
        },
      }),
      { ...deps(), downloads: false },
    )
    expect(checked).toEqual(['Jack http://jack:5225/torznab'])
    expect(outcome.indexer).toEqual({ status: 'skipped', reason: 'downloads-off', disabledUnbound: true })
  })

  test('downloads off still reports a plain skip when the *arr can\'t be checked', async () => {
    const outcome = await registerManagedForDestination(
      stubDest({ disableUnboundIndexer: async () => { throw new Error('ECONNREFUSED') } }),
      { ...deps(), downloads: false },
    )
    expect(outcome.indexer).toEqual({ status: 'skipped', reason: 'downloads-off' })
  })
})
