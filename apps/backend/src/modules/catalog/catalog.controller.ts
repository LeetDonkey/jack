import type { Release } from '../../lib/release'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { TmdbClient, TmdbMediaType, TmdbMetadata } from '../../lib/tmdb/client'
import type { DownloadsService } from '../downloads/downloads.service'
import type { PeerHealthMonitor } from '../friends/peer-health'
import type { PeerReleases, UnifiedCatalogTitle } from './catalog.lib'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { groupReleasesIntoUnifiedTitles, pickBestPerEpisode, pickBestRelease } from './catalog.lib'

const CATALOG_CACHE_MS = 15 * 60_000

/** A peer whose catalog is in the answer. */
export interface CatalogPeer {
  id: string
  name: string
  /** The peer's last health check (every 5 minutes): true online, false offline, null not checked yet. */
  online: boolean | null
  /** When this peer's catalog was fetched (ISO 8601); catalogs are cached for 15 minutes. */
  fetchedAt: string
  /** Seconds since `fetchedAt`. */
  ageSeconds: number
  /** jack just failed to fetch a newer catalog and answers with the cached one. */
  stale: boolean
}

/** A configured peer with nothing in the answer: it isn't connected, or it failed with no cached catalog. */
export interface UnavailableCatalogPeer {
  id: string
  name: string
  online: boolean | null
  /** Why: the connector's error, or the failed catalog request's. */
  error: string | null
}

export interface CatalogResponse {
  // Peers that responded and contributed to this catalog.
  peers: CatalogPeer[]
  // Peers whose library is missing from it.
  unavailable: UnavailableCatalogPeer[]
  titles: UnifiedCatalogTitle[]
  // When the oldest peer catalog in this answer was fetched (they are cached).
  updatedAt: string | null
}

export interface CatalogOptions {
  /** Each peer's last health check, for `online`. */
  health?: Pick<PeerHealthMonitor, 'get'>
  /**
   * Whether catalog requests can start downloads now: `null` when they can,
   * `off` when downloads aren't set up, `restartPending` when they were set up
   * after jack started. Defaults to whether a downloads service was given.
   */
  downloadsInactiveReason?: () => DownloadsInactiveReason | null
}

export type DownloadsInactiveReason = 'off' | 'restartPending'

export interface TmdbStatus {
  configured: boolean
  ok: boolean
  error?: string
}

export interface RequestServerOption {
  id: string
  name: string
  type: 'radarr' | 'sonarr'
  mediaType: 'movie' | 'tv'
  rootFolders: Array<{ path: string, freeSpace?: number }>
}

export interface CatalogRequestInput {
  peerId: string
  serverId: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  tvdbId?: number
  rootFolderPath: string
}

export class CatalogController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[] },
    private readonly tmdb?: TmdbClient,
    private readonly downloads?: DownloadsService,
    private readonly now: () => number = Date.now,
    private readonly options: CatalogOptions = {},
  ) {}

  /** Why catalog requests can't start downloads right now, or null when they can. */
  downloadsInactiveReason(): DownloadsInactiveReason | null {
    if (this.options.downloadsInactiveReason)
      return this.options.downloadsInactiveReason()
    return this.downloads ? null : 'off'
  }

  private online(peer: PeerConnector): boolean | null {
    return this.options.health?.get(peer).online ?? null
  }

  private requirePeer(peerId: string): PeerConnector {
    const peer = this.connectors.peers.find(p => p.id === peerId)
    if (!peer)
      throw new NotFoundError(`No peer found with id "${peerId}"`)
    return peer
  }

  // A peer's catalog is the whole library (thousands of releases), so opening the
  // catalog page reuses it for a while instead of asking the peer every time.
  private readonly peerCatalogs = new Map<string, { at: number, releases: Release[] }>()
  private readonly inFlight = new Map<string, Promise<Release[]>>()

  private async peerCatalog(peer: PeerConnector, refresh: boolean): Promise<{ at: number, releases: Release[], stale: boolean } | { error: string }> {
    const cached = this.peerCatalogs.get(peer.id)
    if (cached && !refresh && this.now() - cached.at < CATALOG_CACHE_MS)
      return { ...cached, stale: false }
    let pending = this.inFlight.get(peer.id)
    if (!pending) {
      pending = peer.listReleases()
      this.inFlight.set(peer.id, pending)
      void pending.finally(() => this.inFlight.delete(peer.id)).catch(() => {})
    }
    try {
      const fresh = { at: this.now(), releases: await pending }
      this.peerCatalogs.set(peer.id, fresh)
      return { ...fresh, stale: false }
    }
    catch (err) {
      // Unreachable right now: show what we had, if anything.
      return cached ? { ...cached, stale: true } : { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async getCatalog({ refresh = false }: { refresh?: boolean } = {}): Promise<CatalogResponse> {
    // Fan out to every initialized peer. A peer that can't serve its catalog is
    // skipped (partial results) rather than failing the whole aggregate.
    const unavailable: UnavailableCatalogPeer[] = this.connectors.peers
      .filter(p => !p.isInitialized)
      .map(p => ({ id: p.id, name: p.name, online: this.online(p), error: p.initializationError ?? 'Not connected yet' }))
    const peers = this.connectors.peers.filter(p => p.isInitialized)
    type Responded = PeerReleases & { at: number, stale: boolean, online: boolean | null }
    const results = await Promise.all(peers.map(async (peer): Promise<Responded | null> => {
      const catalog = await this.peerCatalog(peer, refresh)
      if ('error' in catalog) {
        unavailable.push({ id: peer.id, name: peer.name, online: this.online(peer), error: catalog.error })
        return null
      }
      return { peer: { id: peer.id, name: peer.name }, releases: catalog.releases, at: catalog.at, stale: catalog.stale, online: this.online(peer) }
    }))
    const responded = results.filter((r): r is Responded => r !== null)
    const oldest = responded.length ? Math.min(...responded.map(r => r.at)) : null
    const now = this.now()
    return {
      peers: responded.map(r => ({
        ...r.peer,
        online: r.online,
        fetchedAt: new Date(r.at).toISOString(),
        ageSeconds: Math.max(0, Math.round((now - r.at) / 1000)),
        stale: r.stale,
      })),
      unavailable,
      titles: groupReleasesIntoUnifiedTitles(responded),
      updatedAt: oldest == null ? null : new Date(oldest).toISOString(),
    }
  }

  /** TMDB metadata for a single title; null when TMDB is unconfigured or the id is unknown. */
  async getTitleMetadata(mediaType: TmdbMediaType, tmdbId: number): Promise<TmdbMetadata | null> {
    if (!this.tmdb)
      return null
    return this.tmdb.getMetadata(mediaType, tmdbId)
  }

  async getRequestOptions(): Promise<RequestServerOption[]> {
    const destinations = this.connectors.servers.filter(s => s.canDestination && s.isInitialized)
    const options = await Promise.all(destinations.map(async (s) => {
      try {
        const rootFolders = await s.getRootFolders()
        const type = s.type as 'radarr' | 'sonarr'
        return {
          id: s.id,
          name: s.name,
          type,
          mediaType: type === 'sonarr' ? 'tv' : 'movie',
          rootFolders,
        } satisfies RequestServerOption
      }
      catch {
        // A destination that can't list its root folders can't take a request — drop it.
        return null
      }
    }))
    return options.filter((o): o is RequestServerOption => o !== null)
  }

  async requestDownload(input: CatalogRequestInput): Promise<{ ok: true, server: string, started: number }> {
    if (!this.downloads)
      throw new BadRequestError('Downloads are not configured on this Jack instance')

    const server = this.connectors.servers.find(s => s.id === input.serverId)
    if (!server)
      throw new NotFoundError(`No server found with id "${input.serverId}"`)
    if (!server.canDestination)
      throw new BadRequestError(`Server "${server.name}" is not a destination`)
    // Defense in depth (the UI already filters): a movie must go to Radarr, tv to Sonarr.
    const expectedType = input.mediaType === 'tv' ? 'sonarr' : 'radarr'
    if (server.type !== expectedType)
      throw new BadRequestError(`Server "${server.name}" cannot handle ${input.mediaType} requests`)

    const peer = this.requirePeer(input.peerId)

    if (input.mediaType === 'movie') {
      if (input.tmdbId == null)
        throw new BadRequestError('A tmdbId is required for a movie request')
      const releases = await peer.searchByTmdbId(String(input.tmdbId))
      const best = pickBestRelease(releases)
      if (!best)
        throw new NotFoundError(`Peer "${peer.name}" has no release for tmdbId ${input.tmdbId}`)

      const movieId = await server.add({ tmdbId: input.tmdbId, rootFolderPath: input.rootFolderPath })
      const result = await this.downloads.startDirectDownload({
        peerId: peer.id,
        itemId: best.id,
        destinationServerName: server.name,
        destinationServerId: server.id,
        importTarget: { kind: 'movie', movieId },
      })
      if (result === 'failed')
        throw new BadRequestError(`Failed to start the download for tmdbId ${input.tmdbId} from peer "${peer.name}"`)
      if (result === 'duplicate')
        return { ok: true, server: server.name, started: 0 }
      return { ok: true, server: server.name, started: 1 }
    }

    // --- series (tv): one direct download per best-per-episode release, all bound
    // to the same series so the watcher imports each file into the right show. ---
    if (input.tvdbId == null)
      throw new BadRequestError('A tvdbId is required for a series request')
    const episodeReleases = await peer.searchByTvdbId(String(input.tvdbId))
    const best = pickBestPerEpisode(episodeReleases)
    if (best.length === 0)
      throw new NotFoundError(`Peer "${peer.name}" has no episodes for tvdbId ${input.tvdbId}`)

    const seriesId = await server.add({ tvdbId: input.tvdbId, rootFolderPath: input.rootFolderPath })
    let started = 0
    let accepted = 0
    for (const release of best) {
      const result = await this.downloads.startDirectDownload({
        peerId: peer.id,
        itemId: release.id,
        destinationServerId: server.id,
        destinationServerName: server.name,
        importTarget: { kind: 'series', seriesId },
      })
      if (result === 'failed')
        continue
      accepted++
      if (result === 'started')
        started++
    }
    if (accepted === 0)
      throw new BadRequestError(`Failed to start any episode download for tvdbId ${input.tvdbId} from peer "${peer.name}"`)
    return { ok: true, server: server.name, started }
  }

  async getTmdbStatus(): Promise<TmdbStatus> {
    if (!this.tmdb)
      return { configured: false, ok: false }
    try {
      return { configured: true, ok: await this.tmdb.ping() }
    }
    catch (err) {
      return { configured: true, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
