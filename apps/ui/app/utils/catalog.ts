import type { CatalogPeerFreshness, CatalogRequestOptions, UnavailableCatalogPeer } from '~/types/activity'
import type { CatalogTitle } from '~/types/management'
import { formatTimeAgo } from './server-role'

// ── Search ───────────────────────────────────────────────────────────────────

const ACCENTS = /\p{M}/gu
const NON_WORD = /[^\p{L}\p{N}]+/gu

/** Lowercase, without accents, with punctuation as spaces: "Spider-Man" -> "spider man". */
export function normalizeCatalogSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(ACCENTS, '')
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .trim()
}

/** What a title is found by: every name it is shown under, and its year. */
export interface CatalogSearchFields {
  names: Array<string | null | undefined>
  year: number | null | undefined
}

/** Whether every word of the query appears in the title's names or year. An empty query matches all. */
export function matchesCatalogSearch(fields: CatalogSearchFields, query: string): boolean {
  const words = normalizeCatalogSearch(query).split(' ').filter(Boolean)
  if (words.length === 0)
    return true
  const haystack = normalizeCatalogSearch([...fields.names.filter(Boolean), fields.year ?? ''].join(' '))
  return words.every(word => haystack.includes(word))
}

// ── Sort ─────────────────────────────────────────────────────────────────────

export type CatalogSort = 'added' | 'title' | 'year' | 'rating'

export const CATALOG_SORTS: ReadonlyArray<{ value: CatalogSort, label: string }> = [
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'rating', label: 'Rating' },
]

export function isCatalogSort(value: unknown): value is CatalogSort {
  return CATALOG_SORTS.some(sort => sort.value === value)
}

const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u
const LEADING_ARTICLE = /^(?:the|an|a)\s+/i

/**
 * The key a title sorts under: no leading punctuation ("¡Three Amigos!",
 * "“Wuthering Heights”") and no leading article ("The Matrix" under M).
 */
export function titleSortKey(name: string): string {
  const plain = name.normalize('NFD').replace(ACCENTS, '').trim()
  const stripped = plain.replace(LEADING_PUNCTUATION, '')
  const withoutArticle = stripped.replace(LEADING_ARTICLE, '').replace(LEADING_PUNCTUATION, '')
  return (withoutArticle || stripped || plain).toLowerCase()
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * What a title sorts by. Only data the catalog itself carries (the friend's own
 * Radarr/Sonarr metadata), so the grid doesn't reshuffle while posters and TMDB
 * details load in as the user scrolls.
 */
export function catalogSortFields(title: CatalogTitle & { addedAt?: string | null }) {
  return {
    name: title.metadata?.title || title.displayTitle,
    year: title.metadata?.year ?? null,
    rating: title.metadata?.rating ?? null,
    addedAt: title.addedAt ? Date.parse(title.addedAt) : Number.NaN,
  }
}

/**
 * Sorted copy. Recently added, Year and Rating put the highest first and titles
 * without the value last; ties and Title go by name.
 */
export function sortCatalogTitles<T extends CatalogTitle & { addedAt?: string | null }>(titles: readonly T[], sort: CatalogSort): T[] {
  const rows = titles.map((title) => {
    const fields = catalogSortFields(title)
    return { title, ...fields, key: titleSortKey(fields.name) }
  })
  const byName = (a: typeof rows[number], b: typeof rows[number]) => collator.compare(a.key, b.key) || collator.compare(a.name, b.name)
  const descending = (a: number | null, b: number | null) => {
    const known = (n: number | null) => n != null && !Number.isNaN(n)
    if (known(a) && known(b))
      return (b as number) - (a as number)
    return Number(known(b)) - Number(known(a))
  }
  rows.sort((a, b) => {
    switch (sort) {
      case 'added':
        return descending(a.addedAt, b.addedAt) || byName(a, b)
      case 'year':
        return descending(a.year, b.year) || byName(a, b)
      case 'rating':
        return descending(a.rating, b.rating) || byName(a, b)
      default:
        return byName(a, b)
    }
  })
  return rows.map(row => row.title)
}

// ── Friends ──────────────────────────────────────────────────────────────────

/** Whether a title is in this friend's library. */
export function titleFromFriend(title: Pick<CatalogTitle, 'peers'>, peerId: string): boolean {
  return title.peers.some(peer => peer.id === peerId)
}

export interface CatalogFriendNote {
  peerId: string
  name: string
  // The banner on the page.
  message: string
  // The shorter warning next to Download.
  warning: string
}

/**
 * A banner for each friend whose library in the catalog may be out of date: their
 * last health check failed, or jack couldn't fetch a newer copy just now. A copy
 * fetched under a minute ago is current whatever the health check says.
 */
export function catalogFreshnessNotes(peers: readonly CatalogPeerFreshness[], now: number): CatalogFriendNote[] {
  return peers.flatMap((peer) => {
    const fetched = Date.parse(peer.fetchedAt)
    const ageMs = Number.isNaN(fetched) ? peer.ageSeconds * 1000 : now - fetched
    if (!peer.stale && (peer.online !== false || ageMs < 60_000))
      return []
    const ago = Number.isNaN(fetched) ? '' : formatTimeAgo(peer.fetchedAt, now)
    const from = ago && ago !== 'just now' ? ` from ${ago}` : ''
    const message = peer.online === false
      ? `${peer.name} is offline. Showing their library${from}.`
      : `jack couldn't reach ${peer.name} just now. Showing their library${from}.`
    const warning = peer.online === false
      ? `${peer.name} was offline at the last check, so this may fail. Try again when they're back.`
      : `jack couldn't reach ${peer.name} just now, so this may fail.`
    return [{ peerId: peer.id, name: peer.name, message, warning }]
  })
}

/** The friends missing from the catalog, as "Alice: connect ECONNREFUSED". */
export function unavailableFriendLines(peers: readonly UnavailableCatalogPeer[]): string[] {
  return peers.map(peer => peer.error ? `${peer.name}: ${peer.error}` : peer.name)
}

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * Why Download can't send this title anywhere, or null when it can (or the
 * options aren't known yet; the request dialog says so then):
 * - `off`: downloads aren't set up.
 * - `restart`: they were turned on after jack started.
 * - `no-destination`: no Radarr (movies) or Sonarr (TV) has Download from friends on.
 * - `unreachable`: one has, but jack can't reach it or list its root folders.
 */
export type RequestGate
  = | { kind: 'off' }
    | { kind: 'restart' }
    | { kind: 'no-destination', arr: 'Radarr' | 'Sonarr' }
    | { kind: 'unreachable', arr: 'Radarr' | 'Sonarr', names: string[] }

export interface DestinationServer {
  name: string
  type: string
  destination: boolean
}

export function catalogRequestGate(
  options: CatalogRequestOptions | null | undefined,
  mediaType: 'movie' | 'tv',
  servers: readonly DestinationServer[] = [],
): RequestGate | null {
  if (!options)
    return null
  if (options.downloadsInactiveReason === 'off')
    return { kind: 'off' }
  if (options.downloadsInactiveReason === 'restartPending')
    return { kind: 'restart' }
  if (options.servers.some(server => server.mediaType === mediaType))
    return null
  const type = mediaType === 'tv' ? 'sonarr' : 'radarr'
  const arr = mediaType === 'tv' ? 'Sonarr' : 'Radarr'
  // request-options leaves out a destination jack can't reach.
  const configured = servers.filter(server => server.destination && server.type === type)
  return configured.length
    ? { kind: 'unreachable', arr, names: configured.map(server => server.name) }
    : { kind: 'no-destination', arr }
}

/** The toast after a request, from what jack answered. */
export function catalogRequestToast(result: { server: string, started: number }, mediaType: 'movie' | 'tv', friend: string): { title: string, description: string, fresh: boolean } {
  if (result.started === 0)
    return { title: 'Already downloading or downloaded.', description: 'Nothing new started.', fresh: false }
  const description = mediaType === 'tv'
    ? `${result.started} ${result.started === 1 ? 'episode' : 'episodes'} queued from ${friend}.`
    : `Downloading from ${friend}.`
  return { title: `Sent to ${result.server}.`, description, fresh: true }
}
