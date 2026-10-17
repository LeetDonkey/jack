import type { ReleaseMedia } from '../../release'

interface Cover {
  coverType?: string | null
  remoteUrl?: string | null
}

interface TitleLike {
  title?: string | null
  year?: number | null
  overview?: string | null
  images?: Cover[] | null
  genres?: string[] | null
}

// A catalog card needs a couple of lines, not the full synopsis.
const OVERVIEW_MAX = 400
// TMDB serves every size from the same path; the "original" Radarr links to is several MB.
const TMDB_ORIGINAL = '/t/p/original/'
// TheTVDB keeps a small "_t" copy next to each artwork (a poster drops from ~400 KB to ~80 KB).
const TVDB_ARTWORK = /^(https:\/\/artworks\.thetvdb\.com\/.+?)(?<!_t)(\.(?:jpg|jpeg|png))$/i

function coverUrl(images: Cover[] | null | undefined, type: string, tmdbSize: string): string | undefined {
  const remote = images?.find(i => i.coverType === type)?.remoteUrl
  if (!remote?.startsWith('https://'))
    return undefined
  if (remote.includes(TMDB_ORIGINAL))
    return remote.replace(TMDB_ORIGINAL, `/t/p/${tmdbSize}/`)
  return remote.replace(TVDB_ARTWORK, '$1_t$2')
}

function shorten(text: string): string {
  if (text.length <= OVERVIEW_MAX)
    return text
  const cut = text.slice(0, OVERVIEW_MAX)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), OVERVIEW_MAX - 40)).trimEnd()}…`
}

/**
 * Title-level metadata of the movie or series a file belongs to, as the source
 * arr knows it, so a peer's catalog can show "The Matrix (1999)" with a poster
 * instead of a file name. Image links point at TMDB/TheTVDB, as *arr stores them.
 */
export function releaseMedia(item: TitleLike, rating: number | null | undefined): ReleaseMedia | undefined {
  const title = item.title?.trim()
  if (!title)
    return undefined
  const overview = item.overview?.trim() ? shorten(item.overview.trim()) : undefined
  const posterUrl = coverUrl(item.images, 'poster', 'w342')
  const backdropUrl = coverUrl(item.images, 'fanart', 'w780')
  return {
    title,
    ...(item.year ? { year: item.year } : {}),
    ...(overview ? { overview } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(backdropUrl ? { backdropUrl } : {}),
    ...(item.genres?.length ? { genres: item.genres.slice(0, 6) } : {}),
    ...(typeof rating === 'number' && rating > 0 ? { rating: Math.round(rating * 10) / 10 } : {}),
  }
}
