import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { SonarrServerConnector } from '../lib/servers/arr/sonarr'

const SONARR_URL = 'http://sonarr-fanout.test:8989'
const SERIES_COUNT = 40

let inFlight = 0
let maxInFlight = 0
let episodeRequests: number[] = []

const series = Array.from({ length: SERIES_COUNT }, (_, i) => ({
  id: i + 1,
  title: `Series ${i + 1}`,
  tvdbId: 1000 + i,
  // Every fifth series has no files on disk.
  statistics: { episodeFileCount: (i + 1) % 5 === 0 ? 0 : 1 },
}))

const server = setupServer(
  http.get(`${SONARR_URL}/api/v3/series`, () => HttpResponse.json(series)),
  http.get(`${SONARR_URL}/api/v3/episode`, async ({ request }) => {
    const seriesId = Number(new URL(request.url).searchParams.get('seriesId'))
    episodeRequests.push(seriesId)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight--
    return HttpResponse.json([{
      id: seriesId * 10,
      seriesId,
      seasonNumber: 1,
      episodeNumber: 1,
      hasFile: true,
      episodeFile: { id: seriesId * 100, path: `/tv/Series ${seriesId}/S01E01.mkv`, size: 1 },
    }])
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  inFlight = 0
  maxInFlight = 0
  episodeRequests = []
})
afterAll(() => server.close())

function makeSonarr() {
  const sonarr = new SonarrServerConnector({
    url: SONARR_URL,
    apiKey: 'a'.repeat(32),
    name: 'Fanout Sonarr',
    source: true,
    destination: false,
    autoregister: { enable: false, priority: 1 },
  })
  const c = sonarr as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return sonarr
}

describe('Sonarr library-wide listings', () => {
  test('listReleases caps concurrent episode requests', async () => {
    const releases = await makeSonarr().listReleases()

    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(releases).toHaveLength(SERIES_COUNT - SERIES_COUNT / 5)
  })

  test('an empty search term caps concurrent episode requests', async () => {
    await makeSonarr().searchItems('')

    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  test('series without files are not queried for episodes', async () => {
    await makeSonarr().listReleases()

    const emptySeriesIds = series.filter(s => s.statistics.episodeFileCount === 0).map(s => s.id)
    expect(episodeRequests.some(id => emptySeriesIds.includes(id))).toBe(false)
  })

  test('series without statistics are still queried', async () => {
    server.use(http.get(`${SONARR_URL}/api/v3/series`, () => HttpResponse.json([{ id: 1, title: 'No Stats', tvdbId: 1 }])))

    const releases = await makeSonarr().listReleases()

    expect(episodeRequests).toEqual([1])
    expect(releases).toHaveLength(1)
  })
})
