import type { ArrServerConnector } from './base'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { pickSamples } from './base'
import { RadarrServerConnector } from './radarr'
import { SonarrServerConnector } from './sonarr'

const RADARR_URL = 'http://radarr-folders.test:7878'
const SONARR_URL = 'http://sonarr-folders.test:8989'

const server = setupServer()
let requests: URL[] = []

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  requests = []
})
afterAll(() => server.close())

// Answers `body` on `path` and records each request's URL.
function answer(url: string, body: unknown) {
  return http.get(url, ({ request }) => {
    requests.push(new URL(request.url))
    return HttpResponse.json(body as any)
  })
}

function initialized<T extends ArrServerConnector>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return connector
}

const options = { apiKey: 'a'.repeat(32), source: true, destination: true, autoregister: { enable: false, priority: 1 } }
const makeRadarr = () => initialized(new RadarrServerConnector({ ...options, url: RADARR_URL, name: 'Radarr' }))
const makeSonarr = () => initialized(new SonarrServerConnector({ ...options, url: SONARR_URL, name: 'Sonarr' }))

describe('pickSamples', () => {
  const items = [
    { root: '/movies', value: '/movies/A/A.mkv' },
    { root: '/movies', value: null },
    { root: '/movies', value: '/movies/B/B.mkv' },
    { root: '/movies4k', value: '/movies4k/C/C.mkv' },
  ]

  test('takes one value per root folder first, then the rest in order, and skips items without one', () => {
    expect(pickSamples(items, 2)).toEqual(['/movies/A/A.mkv', '/movies4k/C/C.mkv'])
    expect(pickSamples(items, 3)).toEqual(['/movies/A/A.mkv', '/movies4k/C/C.mkv', '/movies/B/B.mkv'])
    expect(pickSamples(items, 0)).toEqual([])
  })
})

describe('listFolderFiles', () => {
  test('asks for the folder with a trailing slash and files included, and returns the files', async () => {
    server.use(answer(`${RADARR_URL}/api/v3/filesystem`, {
      parent: '/data/',
      directories: [{ type: 'folder', name: 'sub', path: '/data/completed/sub/' }],
      files: [
        { type: 'file', name: 'jack-folder-check-1.txt', path: '/data/completed/jack-folder-check-1.txt', size: 34 },
        { type: 'file', name: 42 },
      ],
    }))

    const files = await makeRadarr().listFolderFiles('/data/completed')

    expect(files).toEqual([{ name: 'jack-folder-check-1.txt', path: '/data/completed/jack-folder-check-1.txt' }])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.pathname).toBe('/api/v3/filesystem')
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
      path: '/data/completed/',
      includeFiles: 'true',
      allowFoldersWithoutTrailingSlashes: 'true',
    })
  })

  test('keeps a single trailing slash, and a listing without files is empty', async () => {
    server.use(answer(`${SONARR_URL}/api/v3/filesystem`, { parent: '/', directories: [] }))

    expect(await makeSonarr().listFolderFiles('/data/completed/')).toEqual([])
    expect(requests[0]!.searchParams.get('path')).toBe('/data/completed/')
  })
})

describe('rootFolders', () => {
  test('returns path and free space, skipping entries without a path', async () => {
    server.use(answer(`${RADARR_URL}/api/v3/rootfolder`, [
      { id: 1, path: '/movies', freeSpace: 1000, accessible: true },
      { id: 2 },
    ]))

    expect(await makeRadarr().rootFolders()).toEqual([{ path: '/movies', freeSpace: 1000 }])
  })
})

describe('sampleFilePaths', () => {
  test('Radarr picks movies with a file, one per root folder first', async () => {
    server.use(answer(`${RADARR_URL}/api/v3/movie`, [
      { id: 1, title: 'No File', hasFile: false, rootFolderPath: '/movies4k' },
      { id: 2, title: 'A', hasFile: true, rootFolderPath: '/movies', movieFile: { id: 20, path: '/movies/A/A.mkv' } },
      { id: 3, title: 'B', hasFile: true, rootFolderPath: '/movies', movieFile: { id: 30, path: '/movies/B/B.mkv' } },
      { id: 4, title: 'C', hasFile: true, rootFolderPath: '/movies4k', movieFile: { id: 40, path: '/movies4k/C/C.mkv' } },
    ]))

    expect(await makeRadarr().sampleFilePaths(2)).toEqual(['/movies/A/A.mkv', '/movies4k/C/C.mkv'])
  })

  test('Sonarr skips series without episode files and asks for the files of the picked series only', async () => {
    server.use(
      answer(`${SONARR_URL}/api/v3/series`, [
        { id: 1, title: 'Empty', rootFolderPath: '/tv', statistics: { episodeFileCount: 0 } },
        { id: 2, title: 'Show', rootFolderPath: '/tv', statistics: { episodeFileCount: 3 } },
        { id: 3, title: 'Other', rootFolderPath: '/tv', statistics: { episodeFileCount: 1 } },
        { id: 4, title: 'Anime', rootFolderPath: '/anime', statistics: { episodeFileCount: 2 } },
      ]),
      http.get(`${SONARR_URL}/api/v3/episodefile`, ({ request }) => {
        const url = new URL(request.url)
        requests.push(url)
        const seriesId = url.searchParams.get('seriesId')
        return HttpResponse.json([{ id: 1, seriesId: Number(seriesId), path: `/series-${seriesId}/S01E01.mkv` }])
      }),
    )

    expect(await makeSonarr().sampleFilePaths(2)).toEqual(['/series-2/S01E01.mkv', '/series-4/S01E01.mkv'])
    const episodeFileRequests = requests.filter(url => url.pathname === '/api/v3/episodefile')
    expect(episodeFileRequests.map(url => url.searchParams.get('seriesId'))).toEqual(['2', '4'])
  })
})
