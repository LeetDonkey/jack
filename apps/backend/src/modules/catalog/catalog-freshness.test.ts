import type { Release } from '../../lib/release'
import { describe, expect, test } from 'bun:test'
import { CatalogController } from './catalog.controller'
import { groupReleasesIntoUnifiedTitles } from './catalog.lib'
import { getCatalogRouter } from './catalog.router'

function movie(overrides: Partial<Release> = {}): Release {
  return { id: `movie:${Math.random()}`, title: 'Movie', filename: 'Movie.mkv', category: 2000, size: 100, ...overrides }
}

describe('catalog addedAt', () => {
  test('is the newest publishDate across a title\'s releases and peers', () => {
    const [title] = groupReleasesIntoUnifiedTitles([
      { peer: { id: 'p1', name: 'Alice' }, releases: [movie({ tmdbId: 1, publishDate: '2026-10-01T10:00:00Z' }), movie({ tmdbId: 1, publishDate: 'garbage' })] },
      { peer: { id: 'p2', name: 'Bob' }, releases: [movie({ tmdbId: 1, publishDate: '2026-10-17T08:00:00+02:00' })] },
    ])
    expect(title!.addedAt).toBe('2026-10-17T06:00:00.000Z')
  })

  test('is null when no release says', () => {
    const [title] = groupReleasesIntoUnifiedTitles([{ peer: { id: 'p1', name: 'Alice' }, releases: [movie({ tmdbId: 1 })] }])
    expect(title!.addedAt).toBeNull()
  })
})

describe('catalog peer freshness', () => {
  test('each peer says whether it is online and how old its catalog is; a failed refresh serves the cache as stale', async () => {
    let now = Date.parse('2026-10-18T12:00:00.000Z')
    let fail = false
    const alice = {
      id: 'p1',
      name: 'Alice',
      isInitialized: true,
      listReleases: async () => {
        if (fail)
          throw new Error('connect ECONNREFUSED')
        return [movie({ tmdbId: 1 })]
      },
    }
    const bob = { id: 'p2', name: 'Bob', isInitialized: false, initializationError: 'timed out', listReleases: async () => [] }
    const online = new Map([['p1', false], ['p2', null]])
    const controller = new CatalogController({ servers: [], peers: [alice, bob] } as any, undefined, undefined, () => now, {
      health: { get: (peer: { id: string }) => ({ online: online.get(peer.id) ?? null }) as any },
    })

    const first = await controller.getCatalog()
    expect(first.peers).toEqual([{ id: 'p1', name: 'Alice', online: false, fetchedAt: '2026-10-18T12:00:00.000Z', ageSeconds: 0, stale: false }])
    expect(first.unavailable).toEqual([{ id: 'p2', name: 'Bob', online: null, error: 'timed out' }])

    now += 3 * 3600_000
    fail = true
    const later = await controller.getCatalog()
    expect(later.peers).toEqual([{ id: 'p1', name: 'Alice', online: false, fetchedAt: '2026-10-18T12:00:00.000Z', ageSeconds: 10_800, stale: true }])
    expect(later.titles).toHaveLength(1)
  })
})

describe('GET /request-options', () => {
  test('says whether downloads can start, and why not', async () => {
    let reason: 'off' | 'restartPending' | null = 'restartPending'
    const controller = new CatalogController({ servers: [], peers: [] } as any, undefined, undefined, Date.now, { downloadsInactiveReason: () => reason })
    const app = getCatalogRouter(controller)

    expect(await (await app.request('/request-options')).json()).toEqual({ servers: [], downloadsActive: false, downloadsInactiveReason: 'restartPending' })
    reason = null
    expect(await (await app.request('/request-options')).json()).toEqual({ servers: [], downloadsActive: true, downloadsInactiveReason: null })
  })

  test('defaults to whether a downloads service exists', () => {
    expect(new CatalogController({ servers: [], peers: [] } as any).downloadsInactiveReason()).toBe('off')
    expect(new CatalogController({ servers: [], peers: [] } as any, undefined, {} as any).downloadsInactiveReason()).toBeNull()
  })
})
