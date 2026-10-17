import { describe, expect, test } from 'bun:test'
import { releaseMedia } from './media'

describe('releaseMedia', () => {
  test('maps an *arr movie or series to catalog metadata with right-sized TMDB images', () => {
    const media = releaseMedia({
      title: 'The Matrix',
      year: 1999,
      overview: 'A hacker learns the truth.',
      images: [
        { coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/poster.jpg' },
        { coverType: 'fanart', remoteUrl: 'https://image.tmdb.org/t/p/original/fanart.jpg' },
        { coverType: 'banner', remoteUrl: 'http://insecure.example/banner.jpg' },
      ],
      genres: ['Action', 'Science Fiction'],
    }, 8.234)

    expect(media).toEqual({
      title: 'The Matrix',
      year: 1999,
      overview: 'A hacker learns the truth.',
      posterUrl: 'https://image.tmdb.org/t/p/w342/poster.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w780/fanart.jpg',
      genres: ['Action', 'Science Fiction'],
      rating: 8.2,
    })
  })

  test('shortens a long synopsis, skips non-https images and a missing title', () => {
    const media = releaseMedia({ title: 'Long', overview: 'word '.repeat(200), images: [{ coverType: 'poster', remoteUrl: 'http://x/p.jpg' }] }, 0)
    expect(media!.overview!.length).toBeLessThanOrEqual(401)
    expect(media!.overview!.endsWith('…')).toBe(true)
    expect(media!.posterUrl).toBeUndefined()
    expect(media!.rating).toBeUndefined()
    expect(releaseMedia({ title: '  ' }, 5)).toBeUndefined()
  })
})

describe('Release.media from a peer', () => {
  test('an invalid media block is dropped without rejecting the release', async () => {
    const { Release } = await import('../../release')
    const parsed = Release.parse({ id: 'c:movie:1', title: 't', filename: 't.mkv', category: 2000, size: 1, media: { title: 'X', posterUrl: 'javascript:alert(1)' } })
    expect(parsed.media).toBeUndefined()
    expect(parsed.id).toBe('c:movie:1')
  })
})
