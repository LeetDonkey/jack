import type { Release } from '../lib/release'
import type { ArrServerConnector } from '../lib/servers/arr/base'
import { describe, expect, test } from 'bun:test'
import { PeerController } from '../modules/peer/peer.controller'

const base: Release = {
  id: 'conn1:movie:1',
  title: 'Movie.2021.1080p',
  filename: 'Movie.2021.1080p.mkv',
  category: 2000,
  size: 10,
}

function fakeSource(releases: Release[], calls: { n: number }): ArrServerConnector {
  return {
    canSource: true,
    listReleases: async () => {
      calls.n++
      return releases
    },
  } as unknown as ArrServerConnector
}

describe('PeerController catalog', () => {
  test('returns only files added since `since` when given', async () => {
    const releases = [
      { ...base, id: 'c:movie:1', publishDate: '2026-10-01T00:00:00Z' },
      { ...base, id: 'c:movie:2', publishDate: '2026-10-16T00:00:00Z' },
      { ...base, id: 'c:movie:3' },
    ]
    const controller = new PeerController(() => [fakeSource(releases, { n: 0 })])

    const recent = await controller.search({ since: '2026-10-10T00:00:00Z' })
    const all = await controller.search({})

    expect(recent.map(r => r.id)).toEqual(['c:movie:2'])
    expect(all).toHaveLength(3)
  })

  test('shares one library listing per source for five minutes', async () => {
    const calls = { n: 0 }
    let now = 0
    const source = fakeSource([base], calls)
    const controller = new PeerController(() => [source], () => now)

    await Promise.all([controller.search({}), controller.search({})])
    now += 4 * 60_000
    await controller.search({})
    expect(calls.n).toBe(1)

    now += 2 * 60_000
    await controller.search({})
    expect(calls.n).toBe(2)
  })

  test('does not cache a failed listing', async () => {
    let fail = true
    const source = {
      canSource: true,
      listReleases: async () => {
        if (fail)
          throw new Error('Sonarr timed out')
        return [base]
      },
    } as unknown as ArrServerConnector
    const controller = new PeerController(() => [source])

    expect(await controller.search({})).toEqual([])
    fail = false
    expect(await controller.search({})).toHaveLength(1)
  })
})
