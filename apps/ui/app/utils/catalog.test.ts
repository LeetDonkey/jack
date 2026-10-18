import { describe, expect, test } from 'bun:test'
import {
  catalogFreshnessNotes,
  catalogRequestGate,
  catalogRequestToast,
  matchesCatalogSearch,
  normalizeCatalogSearch,
  sortCatalogTitles,
  titleFromFriend,
  titleSortKey,
  unavailableFriendLines,
} from './catalog'

function title(displayTitle: string, overrides: Record<string, unknown> = {}) {
  return {
    key: displayTitle,
    mediaType: 'movie',
    displayTitle,
    releaseCount: 1,
    totalSize: 1,
    addedAt: null,
    peers: [{ id: 'alice', name: 'Alice', releaseCount: 1, totalSize: 1, releases: [] }],
    ...overrides,
  } as any
}

const meta = (overrides: Record<string, unknown>) => ({ tmdbId: 1, title: 'x', overview: null, year: null, rating: null, posterUrl: null, backdropUrl: null, genres: [], ...overrides })

describe('catalog search', () => {
  test('matches title words and the year, ignoring case, accents and punctuation', () => {
    const dalmatians = { names: ['101 Dalmatians'], year: 1996 }
    expect(matchesCatalogSearch(dalmatians, 'dalmatians')).toBe(true)
    expect(matchesCatalogSearch(dalmatians, 'Dalmatians 1996')).toBe(true)
    expect(matchesCatalogSearch(dalmatians, 'dalmatians 2000')).toBe(false)
    expect(matchesCatalogSearch({ names: ['Spider-Man: No Way Home'], year: 2021 }, 'spider man')).toBe(true)
    expect(matchesCatalogSearch({ names: ['Amélie'], year: null }, 'amelie')).toBe(true)
  })

  test('looks at every name a title is shown under', () => {
    expect(matchesCatalogSearch({ names: ['La casa de papel', null, 'Money Heist'], year: 2017 }, 'heist')).toBe(true)
  })

  test('matches everything for an empty query', () => {
    expect(matchesCatalogSearch({ names: ['Anything'], year: null }, '   ')).toBe(true)
    expect(normalizeCatalogSearch(' ¡Three  Amigos! ')).toBe('three amigos')
  })
})

describe('titleSortKey', () => {
  test('ignores leading punctuation and articles', () => {
    expect(titleSortKey('¡Three Amigos!')).toBe('three amigos!')
    expect(titleSortKey('“Wuthering Heights”')).toBe('wuthering heights”')
    expect(titleSortKey('The Matrix')).toBe('matrix')
    expect(titleSortKey('A Christmas Carol')).toBe('christmas carol')
    expect(titleSortKey('An American Tail')).toBe('american tail')
  })

  test('keeps words that only start like an article', () => {
    expect(titleSortKey('Theodore Rex')).toBe('theodore rex')
    expect(titleSortKey('Avatar')).toBe('avatar')
    expect(titleSortKey('A')).toBe('a')
  })
})

describe('sortCatalogTitles', () => {
  const names = (titles: Array<{ displayTitle: string }>) => titles.map(t => t.displayTitle)

  test('sorts by title without punctuation or articles getting in front', () => {
    const titles = [title('Zodiac'), title('¡Three Amigos!'), title('The Abyss'), title('“Wuthering Heights”'), title('Air Bud')]
    expect(names(sortCatalogTitles(titles, 'title'))).toEqual(['The Abyss', 'Air Bud', '¡Three Amigos!', '“Wuthering Heights”', 'Zodiac'])
  })

  test('puts the most recently added first and titles without a date last', () => {
    const titles = [
      title('Old', { addedAt: '2026-01-01T00:00:00Z' }),
      title('Unknown'),
      title('New', { addedAt: '2026-10-01T00:00:00Z' }),
    ]
    expect(names(sortCatalogTitles(titles, 'added'))).toEqual(['New', 'Old', 'Unknown'])
  })

  test('sorts by year and rating, highest first, unknown last, ties by title', () => {
    const titles = [
      title('B', { metadata: meta({ title: 'B', year: 1999, rating: 7 }) }),
      title('No metadata'),
      title('A', { metadata: meta({ title: 'A', year: 1999, rating: 8.5 }) }),
      title('C', { metadata: meta({ title: 'C', year: 2024, rating: null }) }),
    ]
    expect(names(sortCatalogTitles(titles, 'year'))).toEqual(['C', 'A', 'B', 'No metadata'])
    expect(names(sortCatalogTitles(titles, 'rating'))).toEqual(['A', 'B', 'C', 'No metadata'])
  })

  test('returns a copy', () => {
    const titles = [title('B'), title('A')]
    sortCatalogTitles(titles, 'title')
    expect(names(titles)).toEqual(['B', 'A'])
  })
})

describe('titleFromFriend', () => {
  test('checks the friends a title is available from', () => {
    expect(titleFromFriend(title('X'), 'alice')).toBe(true)
    expect(titleFromFriend(title('X'), 'bob')).toBe(false)
  })
})

describe('catalogFreshnessNotes', () => {
  const now = Date.parse('2026-10-18T15:00:00Z')
  const peer = (overrides: Record<string, unknown> = {}) => ({
    id: 'alice',
    name: 'Alice',
    online: true,
    fetchedAt: '2026-10-18T12:00:00Z',
    ageSeconds: 0,
    stale: false,
    ...overrides,
  })

  test('says nothing for a friend that is online with a current copy', () => {
    expect(catalogFreshnessNotes([peer()], now)).toEqual([])
  })

  test('names an offline friend and how old their library is', () => {
    const [note] = catalogFreshnessNotes([peer({ online: false })], now)
    expect(note?.message).toBe('Alice is offline. Showing their library from 3 h ago.')
    expect(note?.warning).toContain('Alice was offline at the last check')
  })

  test('names a library jack couldn\'t refresh', () => {
    const [note] = catalogFreshnessNotes([peer({ stale: true, fetchedAt: '2026-10-18T14:40:00Z' })], now)
    expect(note?.message).toBe('jack couldn\'t reach Alice just now. Showing their library from 20 min ago.')
  })

  test('trusts a copy fetched under a minute ago over a failed health check', () => {
    expect(catalogFreshnessNotes([peer({ online: false, fetchedAt: '2026-10-18T14:59:30Z' })], now)).toEqual([])
  })
})

describe('unavailableFriendLines', () => {
  test('lists each friend with the error', () => {
    expect(unavailableFriendLines([
      { id: 'a', name: 'Alice', online: false, error: 'connect ECONNREFUSED' },
      { id: 'b', name: 'Bob', online: null, error: null },
    ])).toEqual(['Alice: connect ECONNREFUSED', 'Bob'])
  })
})

describe('catalogRequestGate', () => {
  const radarr = { id: 'r', name: 'Radarr', type: 'radarr' as const, mediaType: 'movie' as const, rootFolders: [] }
  const options = (overrides: Record<string, unknown> = {}) =>
    ({ servers: [radarr], downloadsActive: true, downloadsInactiveReason: null, ...overrides }) as any

  test('lets a request through when a destination takes this type', () => {
    expect(catalogRequestGate(options(), 'movie')).toBeNull()
  })

  test('waits for the options before blocking anything', () => {
    expect(catalogRequestGate(undefined, 'movie')).toBeNull()
  })

  test('blocks while downloads are off or wait for a restart', () => {
    expect(catalogRequestGate(options({ downloadsActive: false, downloadsInactiveReason: 'off' }), 'movie')).toEqual({ kind: 'off' })
    expect(catalogRequestGate(options({ downloadsActive: false, downloadsInactiveReason: 'restartPending' }), 'movie')).toEqual({ kind: 'restart' })
  })

  test('tells a missing destination from one jack can\'t reach', () => {
    expect(catalogRequestGate(options(), 'tv')).toEqual({ kind: 'no-destination', arr: 'Sonarr' })
    const servers = [{ name: 'Sonarr 4K', type: 'sonarr', destination: true }, { name: 'Sonarr', type: 'sonarr', destination: false }]
    expect(catalogRequestGate(options(), 'tv', servers)).toEqual({ kind: 'unreachable', arr: 'Sonarr', names: ['Sonarr 4K'] })
  })
})

describe('catalogRequestToast', () => {
  test('says where a movie went and who it comes from', () => {
    expect(catalogRequestToast({ server: 'Radarr', started: 1 }, 'movie', 'Alice'))
      .toEqual({ title: 'Sent to Radarr.', description: 'Downloading from Alice.', fresh: true })
  })

  test('counts the episodes queued for a series', () => {
    expect(catalogRequestToast({ server: 'Sonarr', started: 24 }, 'tv', 'Alice').description).toBe('24 episodes queued from Alice.')
    expect(catalogRequestToast({ server: 'Sonarr', started: 1 }, 'tv', 'Alice').description).toBe('1 episode queued from Alice.')
  })

  test('says so when nothing new started', () => {
    expect(catalogRequestToast({ server: 'Radarr', started: 0 }, 'movie', 'Alice'))
      .toEqual({ title: 'Already downloading or downloaded.', description: 'Nothing new started.', fresh: false })
  })
})
