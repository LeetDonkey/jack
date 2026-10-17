import type { Release } from '../../lib/release'
import type { PeerConnector } from '../../lib/servers/peer'
import type { PieceList } from '../peer/piece-hasher'
import type { PieceSource } from './piece-verifier'
import { logger } from '../../logger'
import { samePieces } from '../peer/piece-hasher'

export interface DownloadSource {
  peer: PeerConnector
  itemId: string
}

// While a peer is still hashing, ask again this often.
const PIECES_POLL_MS = 30_000

async function piecesOf(source: DownloadSource): Promise<PieceList | 'pending' | null> {
  try {
    return await source.peer.getPieces(source.itemId)
  }
  catch {
    return null
  }
}

/**
 * The peers a download can be fetched from: the one *arr grabbed from, plus any
 * other peer whose file has the same piece hashes (so the .part can continue
 * from it byte for byte). Mirrors are looked up after the first failure, so a
 * download that never fails costs the other peers nothing.
 */
export class DownloadSources {
  private readonly primaryPieces: Promise<PieceList | 'pending' | null>
  private mirrors: DownloadSource[] | undefined
  private currentIndex = 0

  constructor(
    private readonly primary: DownloadSource,
    private readonly release: Pick<Release, 'size' | 'tmdbId' | 'tvdbId' | 'season' | 'episode'>,
    private readonly peers: () => PeerConnector[],
    private readonly sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms),
  ) {
    // Asking early makes the peer start hashing while the transfer runs.
    this.primaryPieces = piecesOf(primary)
  }

  get current(): DownloadSource {
    return this.all()[this.currentIndex] ?? this.primary
  }

  private all(): DownloadSource[] {
    return [this.primary, ...(this.mirrors ?? [])]
  }

  /** After a failed attempt: switch to the next byte-identical peer, if there is one. */
  async advance(): Promise<DownloadSource> {
    if (this.mirrors === undefined)
      this.mirrors = await this.findMirrors()
    const all = this.all()
    if (all.length > 1) {
      const from = this.current
      this.currentIndex = (this.currentIndex + 1) % all.length
      logger.info({ from: from.peer.name, to: this.current.peer.name }, 'Continuing download from another peer with the same file')
    }
    return this.current
  }

  private async findMirrors(): Promise<DownloadSource[] | undefined> {
    const primaryPieces = await this.primaryPieces
    // Without the primary's hashes there is nothing to compare against yet; try again next time.
    if (primaryPieces === 'pending')
      return undefined
    if (!primaryPieces)
      return []
    const others = this.peers().filter(p => p.id !== this.primary.peer.id)
    const found = await Promise.all(others.map(async (peer) => {
      try {
        const releases = this.release.tmdbId != null
          ? await peer.searchByTmdbId(String(this.release.tmdbId))
          : this.release.tvdbId != null
            ? await peer.searchByTvdbId(String(this.release.tvdbId), this.release.season, this.release.episode)
            : []
        for (const candidate of releases.filter(r => r.size === this.release.size)) {
          const pieces = await piecesOf({ peer, itemId: candidate.id })
          if (pieces && pieces !== 'pending' && samePieces(primaryPieces, pieces))
            return { peer, itemId: candidate.id }
        }
      }
      catch (err) {
        logger.debug({ peer: peer.name, err }, 'Could not look for the same file at peer')
      }
      return null
    }))
    return found.filter((m): m is DownloadSource => m != null)
  }

  /**
   * The piece list to verify against: the primary's, else a mirror's (they are
   * identical). Waits up to `waitMs` while it is still being hashed; null when
   * no peer has one (older jacks).
   */
  async pieceList(waitMs: number): Promise<PieceList | null> {
    const deadline = Date.now() + waitMs
    let pieces = await this.primaryPieces
    // The early answer may be hours old; a pending one is worth asking again now.
    if (pieces === 'pending')
      pieces = await piecesOf(this.primary)
    while (true) {
      if (pieces && pieces !== 'pending')
        return pieces
      for (const mirror of this.mirrors ?? []) {
        const mirrorPieces = await piecesOf(mirror)
        if (mirrorPieces && mirrorPieces !== 'pending')
          return mirrorPieces
      }
      if (pieces === null && !(this.mirrors?.length))
        return null
      if (Date.now() + PIECES_POLL_MS > deadline)
        return null
      await this.sleep(PIECES_POLL_MS)
      pieces = await piecesOf(this.primary)
    }
  }

  /** Every known source as a piece fetcher, the current one first. */
  pieceSources(signal?: AbortSignal): PieceSource[] {
    const ordered = [this.current, ...this.all().filter(s => s !== this.current)]
    return ordered.map(source => (start, end) => source.peer.fetchRange(source.itemId, start, end, signal))
  }
}
