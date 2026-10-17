import type { CatalogTitle, TmdbMetadata } from '~/types/management'

/**
 * Whether a catalog title should be looked up on TMDB: it has an id, and the peer's
 * Radarr/Sonarr sent no metadata or no artwork for it (older jacks send none).
 */
export function needsTmdbMetadata(title: Pick<CatalogTitle, 'tmdbId' | 'metadata'>): boolean {
  if (title.tmdbId == null)
    return false
  const peer = title.metadata
  return !peer || (!peer.posterUrl && !peer.backdropUrl)
}

/** The peer's metadata first, with TMDB filling in only what the peer left empty. */
export function mergeCatalogMetadata(peer: TmdbMetadata | null | undefined, tmdb: TmdbMetadata | null | undefined): TmdbMetadata | null {
  if (!peer)
    return tmdb ?? null
  if (!tmdb)
    return peer
  return {
    ...peer,
    overview: peer.overview ?? tmdb.overview,
    year: peer.year ?? tmdb.year,
    rating: peer.rating ?? tmdb.rating,
    posterUrl: peer.posterUrl ?? tmdb.posterUrl,
    backdropUrl: peer.backdropUrl ?? tmdb.backdropUrl,
    genres: peer.genres.length ? peer.genres : tmdb.genres,
  }
}
