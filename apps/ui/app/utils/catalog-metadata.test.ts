import type { TmdbMetadata } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { mergeCatalogMetadata, needsTmdbMetadata } from './catalog-metadata'

const peer: TmdbMetadata = { tmdbId: 603, title: 'The Matrix', overview: null, year: 1999, rating: null, posterUrl: null, backdropUrl: null, genres: [] }
const tmdb: TmdbMetadata = { tmdbId: 603, title: 'Matrix', overview: 'A hacker.', year: 1999, rating: 8.2, posterUrl: 'https://img/p.jpg', backdropUrl: 'https://img/b.jpg', genres: ['Action'] }

describe('catalog metadata', () => {
  test('asks TMDB only for titles with an id and no artwork from the peer', () => {
    expect(needsTmdbMetadata({ tmdbId: 603, metadata: null })).toBe(true)
    expect(needsTmdbMetadata({ tmdbId: 603, metadata: peer })).toBe(true)
    expect(needsTmdbMetadata({ tmdbId: 603, metadata: { ...peer, posterUrl: 'https://img/x.jpg' } })).toBe(false)
    expect(needsTmdbMetadata({ tmdbId: undefined, metadata: null })).toBe(false)
  })

  test('keeps the peer\'s fields and lets TMDB fill only the empty ones', () => {
    expect(mergeCatalogMetadata(peer, tmdb)).toEqual({ ...tmdb, title: 'The Matrix' })
    expect(mergeCatalogMetadata({ ...peer, posterUrl: 'https://peer/p.jpg', genres: ['Sci-Fi'] }, tmdb)).toMatchObject({ posterUrl: 'https://peer/p.jpg', genres: ['Sci-Fi'] })
    expect(mergeCatalogMetadata(null, tmdb)).toBe(tmdb)
    expect(mergeCatalogMetadata(peer, null)).toBe(peer)
    expect(mergeCatalogMetadata(undefined, undefined)).toBeNull()
  })
})
