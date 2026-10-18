import type { Release } from '../lib/release'
import type { ArrServerConnector } from '../lib/servers/arr/base'
import type { PeerConnector } from '../lib/servers/peer'
import { describe, expect, test } from 'bun:test'
import { releaseToTorznab, TorznabController } from '../modules/torznab/torznab.controller'
import { buildErrorXml, buildSearchResultXml } from '../modules/torznab/torznab.router'

const movieRelease: Release = {
  id: 'conn1:movie:42',
  title: 'Test.Movie.2021.1080p.BluRay.x264-GROUP',
  filename: 'Test.Movie.2021.1080p.BluRay.x264-GROUP.mkv',
  category: 2000,
  size: 2_000_000_000,
  imdbId: 'tt9999999',
  tmdbId: 12345,
  quality: { name: 'Bluray-1080p', source: 'bluray', resolution: 1080 },
  releaseGroup: 'GROUP',
}

const episodeRelease: Release = {
  id: 'conn2:episode:7',
  title: 'Show.S01E02.1080p.WEB-DL-GRP',
  filename: 'Show.S01E02.1080p.WEB-DL-GRP.mkv',
  category: 5000,
  size: 500_000_000,
  tvdbId: 654321,
  season: 1,
  episode: 2,
  seriesTitle: 'Show',
}

const JACK_API_KEY = 'test-api-key'

function attrValue(item: Record<string, any>, name: string): unknown {
  return (item['torznab:attr'] as Array<Record<string, any>>)
    .find(a => a['@name'] === name)?.['@value']
}

describe('Torznab XML helpers', () => {
  test('buildSearchResultXml returns RSS with items', () => {
    const result = buildSearchResultXml([releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)])
    expect(result.rss['@version']).toBe('2.0')
    expect(result.rss['@xmlns:torznab']).toContain('torznab')

    const item = result.rss.channel.item[0]
    expect(item.title).toBe('Test.Movie.2021.1080p.BluRay.x264-GROUP')
    expect(item.guid).toBe('peer1:conn1:movie:42')
    expect(new URL(item.link).searchParams.get('apikey')).toBe(JACK_API_KEY)
    expect(new URL(item.enclosure['@url']).searchParams.get('apikey')).toBe(JACK_API_KEY)
    expect(item.enclosure['@type']).toBe('application/x-bittorrent')
    expect(attrValue(item, 'category')).toBe(2000)
    expect(attrValue(item, 'imdbid')).toBe('tt9999999')
    expect(attrValue(item, 'tmdbid')).toBe(12345)
    expect(attrValue(item, 'downloadvolumefactor')).toBe(0)
    expect(attrValue(item, 'uploadvolumefactor')).toBe(1)
  })

  test('buildSearchResultXml tags every item as an internal release', () => {
    // *arr's TorznabRssParser maps `tag=internal` to the Internal indexer flag,
    // so a custom format (IndexerFlagSpecification) can target Jack releases.
    const result = buildSearchResultXml([releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)])
    const tags = (result.rss.channel.item[0]['torznab:attr'] as Array<Record<string, any>>)
      .filter(a => a['@name'] === 'tag')
      .map(a => a['@value'])
    expect(tags).toContain('internal')
  })

  test('buildSearchResultXml emits tv attrs for episodes', () => {
    const result = buildSearchResultXml([releaseToTorznab(episodeRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)])
    const item = result.rss.channel.item[0]
    expect(attrValue(item, 'category')).toBe(5000)
    expect(attrValue(item, 'tvdbid')).toBe(654321)
    expect(attrValue(item, 'season')).toBe(1)
    expect(attrValue(item, 'episode')).toBe(2)
  })

  test('buildSearchResultXml handles empty results', () => {
    const result = buildSearchResultXml([])
    expect(result.rss.channel.item).toEqual([])
  })

  test('buildErrorXml returns error element', () => {
    const result = buildErrorXml(100, 'Incorrect API Key')
    expect(result.error['@code']).toBe(100)
    expect(result.error['@description']).toBe('Incorrect API Key')
  })

  test('buildSearchResultXml passes special characters through raw (encoder handles escaping)', () => {
    const release: Release = {
      id: 'conn1:movie:1',
      title: 'Movie <with> "special" & \'chars\'',
      filename: 'movie.mkv',
      category: 2000,
      size: 100,
    }

    const result = buildSearchResultXml([releaseToTorznab(release, 'peer1', undefined, 'http://localhost', JACK_API_KEY)])
    expect(result.rss.channel.item[0].title).toBe('Movie <with> "special" & \'chars\'')
  })
})

describe('TorznabController embeds the requester key in download URLs', () => {
  // The main key is deprecated/often unset; the requester (Radarr) authenticates
  // the indexer with a managed key. Each download URL must carry THAT key so the
  // grab passes auth — not the main key, which would 401 when unset.
  const jackConfig = { internalUrl: 'http://localhost:3000', apiKey: 'main-key' } as any

  function fakePeer(releases: Release[]): PeerConnector {
    return {
      id: 'peer1',
      name: 'Friend',
      searchByTmdbId: async () => releases,
      searchByImdbId: async () => releases,
      searchByTvdbId: async () => releases,
      listReleases: async () => releases,
    } as unknown as PeerConnector
  }

  test('searchMovie embeds the passed request key, not the main key', async () => {
    const controller = new TorznabController(() => [fakePeer([movieRelease])], () => jackConfig.internalUrl)
    const items = await controller.searchMovie({ tmdbId: '12345' }, 'jack_managed_abc')
    expect(items).toHaveLength(1)
    expect(new URL(items[0]!.downloadUrl).searchParams.get('apikey')).toBe('jack_managed_abc')
  })

  test('searchTv embeds the passed request key', async () => {
    const controller = new TorznabController(() => [fakePeer([episodeRelease])], () => jackConfig.internalUrl)
    const items = await controller.searchTv('654321', 1, 2, 'jack_managed_tv')
    expect(new URL(items[0]!.downloadUrl).searchParams.get('apikey')).toBe('jack_managed_tv')
  })

  test('reads the internal URL per request, so a saved one applies to the next feed', async () => {
    let internalUrl = 'http://jack:5225'
    const controller = new TorznabController(() => [fakePeer([movieRelease])], () => internalUrl)
    const host = async () => new URL((await controller.searchMovie({ tmdbId: '12345' }, 'jack_managed_abc'))[0]!.downloadUrl).host

    expect(await host()).toBe('jack:5225')
    internalUrl = 'http://192.168.1.10:5225'
    expect(await host()).toBe('192.168.1.10:5225')
  })

  test('catalog embeds the passed request key', async () => {
    const controller = new TorznabController(() => [fakePeer([{ ...movieRelease, publishDate: new Date().toISOString() }])], () => jackConfig.internalUrl)
    const items = await controller.catalog('jack_managed_xyz')
    expect(new URL(items[0]!.downloadUrl).searchParams.get('apikey')).toBe('jack_managed_xyz')
  })
})

describe('releaseToTorznab', () => {
  test('maps a movie release', () => {
    const result = releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)
    expect(result.title).toBe('Test.Movie.2021.1080p.BluRay.x264-GROUP')
    expect(result.category).toBe(2000)
    expect(result.imdbId).toBe('tt9999999')
    expect(result.tmdbId).toBe(12345)
    expect(result.guid).toBe('peer1:conn1:movie:42')
    expect(result.size).toBe(2_000_000_000)
    expect(result.downloadUrl).toContain('/torznab/download/')
    expect(result.downloadUrl).toContain(encodeURIComponent('peer1:conn1:movie:42'))
    expect(new URL(result.downloadUrl).searchParams.get('apikey')).toBe(JACK_API_KEY)
  })

  test('maps an episode release to the TV category with season/episode', () => {
    const result = releaseToTorznab(episodeRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)
    expect(result.category).toBe(5000)
    expect(result.tvdbId).toBe(654321)
    expect(result.season).toBe(1)
    expect(result.episode).toBe(2)
    expect(result.guid).toBe('peer1:conn2:episode:7')
  })
})

describe('TorznabController RSS feed', () => {
  const jackConfig = { internalUrl: 'http://localhost:3000' } as any
  const now = Date.parse('2026-10-17T12:00:00Z')
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString()

  function feedPeer(releases: Release[], seen: Array<string | undefined>): PeerConnector {
    return {
      id: 'peer1',
      name: 'Friend',
      listReleases: async (since?: string) => {
        seen.push(since)
        return releases
      },
    } as unknown as PeerConnector
  }

  test('offers only releases added within rssMaxAgeDays, newest first', async () => {
    const seen: Array<string | undefined> = []
    const releases = [
      { ...movieRelease, id: 'c:movie:1', publishDate: daysAgo(10) },
      { ...movieRelease, id: 'c:movie:2', publishDate: daysAgo(1) },
      { ...movieRelease, id: 'c:movie:3' },
      { ...movieRelease, id: 'c:movie:4', publishDate: daysAgo(3) },
    ]
    const controller = new TorznabController(() => [feedPeer(releases, seen)], () => jackConfig.internalUrl, () => ({ rssMaxAgeDays: 7, rssMaxItems: 100 }))

    const items = await controller.catalog('key', now)

    expect(items.map(i => i.guid)).toEqual(['peer1:c:movie:2', 'peer1:c:movie:4'])
    // The peer is asked to filter at the source too.
    expect(seen).toEqual([daysAgo(7)])
  })

  test('caps the feed at rssMaxItems', async () => {
    const releases = Array.from({ length: 5 }, (_, i) => ({ ...movieRelease, id: `c:movie:${i}`, publishDate: daysAgo(i) }))
    const controller = new TorznabController(() => [feedPeer(releases, [])], () => jackConfig.internalUrl, () => ({ rssMaxAgeDays: 30, rssMaxItems: 2 }))

    const items = await controller.catalog('key', now)

    expect(items.map(i => i.guid)).toEqual(['peer1:c:movie:0', 'peer1:c:movie:1'])
  })
})

describe('TorznabController upgrade policy', () => {
  const jackConfig = { internalUrl: 'http://localhost:3000' } as any
  const GiB = 1024 ** 3
  const item = (tmdbId: number, size: number) => releaseToTorznab({ ...movieRelease, id: `c:movie:${tmdbId}`, tmdbId, size }, 'peer1', 'Friend', 'http://localhost:3000', 'k')

  function destination(upgrades: { allow: boolean, maxSizeGiB?: number | null }, owned: Set<number>, lookups: number[] = []) {
    return {
      id: 'radarr1',
      name: 'Radarr',
      upgrades,
      ownedFiles: async ({ tmdbId }: { tmdbId?: number }) => {
        lookups.push(tmdbId!)
        if (tmdbId === 666)
          throw new Error('Radarr timed out')
        return owned.has(tmdbId!) ? [movieRelease] : []
      },
    } as unknown as ArrServerConnector
  }

  const controllerFor = (dest: ArrServerConnector) =>
    new TorznabController(() => [], () => jackConfig.internalUrl, undefined, id => (id === dest.id ? dest : undefined))

  test('with upgrades off, offers only what the destination is missing', async () => {
    const controller = controllerFor(destination({ allow: false }, new Set([1])))

    const offered = await controller.applyUpgradePolicy([item(1, GiB), item(2, GiB)], 'radarr1')

    expect(offered.map(i => i.tmdbId)).toEqual([2])
  })

  test('a size cap lets small upgrades through and holds back large ones, but never a missing item', async () => {
    const lookups: number[] = []
    const controller = controllerFor(destination({ allow: true, maxSizeGiB: 20 }, new Set([1, 2]), lookups))

    const offered = await controller.applyUpgradePolicy([item(1, 10 * GiB), item(2, 40 * GiB), item(3, 40 * GiB)], 'radarr1')

    expect(offered.map(i => i.tmdbId)).toEqual([1, 3])
    // An upgrade under the cap needs no lookup.
    expect(lookups).toEqual([2, 3])
  })

  test('leaves an item out when the lookup fails, and offers everything without a policy or destination', async () => {
    const restricted = controllerFor(destination({ allow: false }, new Set()))
    expect(await restricted.applyUpgradePolicy([item(666, GiB), item(2, GiB)], 'radarr1')).toHaveLength(1)

    const open = controllerFor(destination({ allow: true }, new Set([1])))
    expect(await open.applyUpgradePolicy([item(1, GiB)], 'radarr1')).toHaveLength(1)
    expect(await restricted.applyUpgradePolicy([item(1, GiB)], undefined)).toHaveLength(1)
  })

  test('reuses an ownership answer for ten minutes', async () => {
    const lookups: number[] = []
    const controller = controllerFor(destination({ allow: false }, new Set(), lookups))

    await controller.applyUpgradePolicy([item(1, GiB)], 'radarr1', 0)
    await controller.applyUpgradePolicy([item(1, GiB)], 'radarr1', 9 * 60_000)
    await controller.applyUpgradePolicy([item(1, GiB)], 'radarr1', 11 * 60_000)

    expect(lookups).toEqual([1, 1])
  })
})
