import type { AppConfig, TorznabConfig } from '../../lib/config'
import type { Release } from '../../lib/release'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import { Semaphore } from '../../lib/semaphore'
import { setSpanAttribute } from '../../lib/span-attributes'
import { withSpan } from '../../lib/tracing'
import { logger } from '../../logger'

export interface TorznabItem {
  title: string
  guid: string
  size: number
  downloadUrl: string
  category: number
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  season?: number
  episode?: number
  publishDate?: string
  peerId: string
  peerName?: string
}

function buildDownloadUrl(internalUrl: string, guid: string, apiKey: string): string {
  const trimmedInternalUrl = internalUrl.endsWith('/') ? internalUrl.slice(0, -1) : internalUrl
  const url = new URL(`${trimmedInternalUrl}/torznab/download/${encodeURIComponent(guid)}.torrent`)
  url.searchParams.set('apikey', apiKey)
  return url.toString()
}

export function releaseToTorznab(release: Release, peerId: string, peerName: string | undefined, internalUrl: string, apiKey: string): TorznabItem {
  const guid = `${peerId}:${release.id}`

  return {
    title: release.title,
    guid,
    size: release.size,
    downloadUrl: buildDownloadUrl(internalUrl, guid, apiKey),
    category: release.category,
    imdbId: release.imdbId,
    tmdbId: release.tmdbId,
    tvdbId: release.tvdbId,
    season: release.season,
    episode: release.episode,
    publishDate: release.publishDate,
    peerId,
    peerName,
  }
}

// How long "does this *arr already have it?" answers are reused, and how many
// lookups one feed may run against that *arr at once.
const OWNED_CACHE_MS = 10 * 60_000
const OWNED_LOOKUP_CONCURRENCY = 4

export class TorznabController {
  private readonly ownedCache = new Map<string, { at: number, owned: Promise<boolean> }>()

  constructor(
    private readonly getPeers: () => PeerConnector[],
    private readonly jackConfig: NonNullable<AppConfig['jack']>,
    // Read on every RSS request so a change in the management UI applies at once.
    private readonly getTorznabConfig: () => TorznabConfig = () => ({ rssMaxAgeDays: 7, rssMaxItems: 100 }),
    // The destination a managed key belongs to, for its upgrade policy.
    private readonly getDestination: (id: string) => ArrServerConnector | undefined = () => undefined,
  ) {}

  /**
   * Drop releases the requesting destination's upgrade policy rules out. With
   * upgrades off, that is anything the destination already has a file for; with a
   * size cap, upgrades above it. Missing items always stay. A lookup that fails
   * drops the item (this poll only): offering it could start a large transfer
   * the policy was set to prevent.
   */
  async applyUpgradePolicy(items: TorznabItem[], destinationId: string | undefined, now = Date.now()): Promise<TorznabItem[]> {
    const dest = destinationId ? this.getDestination(destinationId) : undefined
    if (!dest || items.length === 0)
      return items
    const { allow, maxSizeGiB } = dest.upgrades
    if (allow && maxSizeGiB == null)
      return items
    const maxUpgradeBytes = allow && maxSizeGiB != null ? maxSizeGiB * 1024 ** 3 : -1
    this.pruneOwnedCache(now)
    const limit = new Semaphore(OWNED_LOOKUP_CONCURRENCY)
    const keep = await Promise.all(items.map(async (item) => {
      if (item.size <= maxUpgradeBytes)
        return true
      try {
        return !(await limit.run(() => this.owns(dest, item, now)))
      }
      catch (err) {
        logger.warn({ destination: dest.name, title: item.title, err }, 'Could not check whether the destination already has this release; leaving it out')
        return false
      }
    }))
    return items.filter((_, i) => keep[i])
  }

  private owns(dest: ArrServerConnector, item: TorznabItem, now: number): Promise<boolean> {
    const key = [dest.id, item.tmdbId ?? item.imdbId ?? '', item.tvdbId ?? '', item.season ?? '', item.episode ?? ''].join(':')
    const cached = this.ownedCache.get(key)
    if (cached && now - cached.at < OWNED_CACHE_MS)
      return cached.owned
    const owned = dest.ownedFiles(item).then(files => files.length > 0)
    this.ownedCache.set(key, { at: now, owned })
    owned.catch(() => {
      if (this.ownedCache.get(key)?.owned === owned)
        this.ownedCache.delete(key)
    })
    return owned
  }

  private pruneOwnedCache(now: number): void {
    for (const [key, entry] of this.ownedCache) {
      if (now - entry.at >= OWNED_CACHE_MS)
        this.ownedCache.delete(key)
    }
  }

  private async fanOut(label: string, search: (peer: PeerConnector) => Promise<Release[]>, apiKey: string): Promise<TorznabItem[]> {
    // We fan out to ALL peers — no isInitialized pre-filter. A peer that failed
    // to connect at boot gets re-initialized lazily by @requireInitialization on
    // the call below, so a peer that came back online rejoins searches without a
    // restart. Each peer is isolated: if it fails (still down, or errors), we log
    // and treat it as zero results instead of failing the whole search.
    const peers = this.getPeers()
    return withSpan('torznab.fan_out', {
      'search.label': label,
      'peer.count': peers.length,
    }, async (span) => {
      if (peers.length === 0) {
        setSpanAttribute(span, 'release.count', 0)
        return []
      }

      const results = await Promise.all(
        peers.map(async (peer) => {
          try {
            return await withSpan('torznab.peer_search', {
              'search.label': label,
              'peer.name': peer.name,
              'peer.id': peer.id,
            }, async (peerSpan) => {
              const releases = await search(peer)
              setSpanAttribute(peerSpan, 'release.count', releases.length)
              // Embed the SAME key the requester authenticated with (passed down
              // from the request), so the grab of this release's .torrent passes
              // auth — the deprecated main key (jackConfig.apiKey) is often unset.
              return releases.map(release => releaseToTorznab(release, peer.id, peer.name, this.jackConfig.internalUrl, apiKey))
            })
          }
          catch (err) {
            logger.error({ search: label, peer: peer.name, err }, 'Peer search failed — skipping this peer')
            return []
          }
        }),
      )

      const items = results.flat()
      setSpanAttribute(span, 'release.count', items.length)
      return items
    })
  }

  async searchMovie(ids: { tmdbId?: string, imdbId?: string }, apiKey: string): Promise<TorznabItem[]> {
    const { tmdbId, imdbId } = ids
    // Prefer tmdbid: Radarr filters by it server-side (a targeted lookup), and it
    // doesn't depend on the tt-prefix quirk. imdbid is the fallback.
    if (tmdbId)
      return this.fanOut(`tmdb:${tmdbId}`, peer => peer.searchByTmdbId(tmdbId), apiKey)
    if (imdbId)
      return this.fanOut(`imdb:${imdbId}`, peer => peer.searchByImdbId(imdbId), apiKey)
    return []
  }

  async searchTv(tvdbId: string, season: number | undefined, episode: number | undefined, apiKey: string): Promise<TorznabItem[]> {
    return this.fanOut(`tvdb:${tvdbId} s:${season ?? '-'} e:${episode ?? '-'}`, peer => peer.searchByTvdbId(tvdbId, season, episode), apiKey)
  }

  /**
   * The torznab RSS feed: releases peers added within rssMaxAgeDays, newest
   * first, at most rssMaxItems. Offering every peer's whole catalog made *arr
   * grab every possible upgrade in a single RSS sync. Peers that understand
   * `since` filter at the source; older ones send everything and are filtered here.
   */
  async catalog(apiKey: string, now = Date.now()): Promise<TorznabItem[]> {
    const { rssMaxAgeDays, rssMaxItems } = this.getTorznabConfig()
    const sinceMs = now - rssMaxAgeDays * 86_400_000
    const since = new Date(sinceMs).toISOString()
    const items = await this.fanOut('catalog', peer => peer.listReleases(since), apiKey)
    return items
      .map(item => ({ item, at: item.publishDate ? Date.parse(item.publishDate) : Number.NaN }))
      .filter(({ at }) => at >= sinceMs)
      .sort((a, b) => b.at - a.at)
      .slice(0, rssMaxItems)
      .map(({ item }) => item)
  }
}
