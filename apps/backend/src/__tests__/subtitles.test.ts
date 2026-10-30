import type { Release } from '../lib/release'
import type { ArrServerConnector } from '../lib/servers/arr/base'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { openDatabase } from '../database/connection'
import { RadarrServerConnector } from '../lib/servers/arr/radarr'
import { SonarrServerConnector } from '../lib/servers/arr/sonarr'
import { isInside, isSafeSubtitleSuffix, MAX_SUBTITLE_BYTES, subtitlePathFor, subtitleSuffix } from '../lib/subtitles'
import { unlinkSubtitleSiblings } from '../modules/downloads/artifact-cleanup'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { DownloadsService } from '../modules/downloads/downloads.service'
import { PeerController } from '../modules/peer/peer.controller'
import { getPeerRouter } from '../modules/peer/peer.router'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-subtitles-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('subtitleSuffix', () => {
  const video = '/movies/Film (2020)/Film (2020) WEBDL-1080p.mkv'

  test('keeps what follows the video\'s name', () => {
    expect(subtitleSuffix(video, { path: '/movies/Film (2020)/Film (2020) WEBDL-1080p.da.srt' }, 0)).toBe('.da.srt')
    expect(subtitleSuffix(video, { path: '/movies/Film (2020)/Film (2020) WEBDL-1080p.en.forced.ass' }, 1)).toBe('.en.forced.ass')
  })

  test('names a differently named file by its language tags and title, or its number', () => {
    expect(subtitleSuffix(video, { path: '/movies/Film (2020)/Subs/2_Danish.srt', languageTags: ['da'], title: 'SDH' }, 0)).toBe('.da.SDH.srt')
    expect(subtitleSuffix(video, { path: '/movies/Film (2020)/Subs/3.SUP', languageTags: [] }, 2)).toBe('.3.sup')
  })

  test('is null for a file that isn\'t a subtitle', () => {
    expect(subtitleSuffix(video, { path: '/movies/Film (2020)/Film (2020) WEBDL-1080p.nfo' }, 0)).toBeNull()
  })
})

describe('isSafeSubtitleSuffix', () => {
  test('accepts a plain suffix with a subtitle extension', () => {
    expect(isSafeSubtitleSuffix('.da.srt')).toBe(true)
    expect(isSafeSubtitleSuffix('.en forced.ass')).toBe(true)
  })

  test('refuses path parts, parent references and other extensions', () => {
    expect(isSafeSubtitleSuffix('/../../etc/x.srt')).toBe(false)
    expect(isSafeSubtitleSuffix('..srt')).toBe(false)
    expect(isSafeSubtitleSuffix('.da/../x.srt')).toBe(false)
    expect(isSafeSubtitleSuffix('.da.mkv')).toBe(false)
    expect(isSafeSubtitleSuffix('da.srt')).toBe(false)
  })
})

describe('subtitlePathFor and isInside', () => {
  test('puts the suffix in place of the video\'s extension', () => {
    expect(subtitlePathFor('/data/jack/Film.2020.mkv', '.da.srt')).toBe('/data/jack/Film.2020.da.srt')
  })

  test('only counts paths below the folder', () => {
    expect(isInside('/movies/Film', '/movies/Film/Subs/a.srt')).toBe(true)
    expect(isInside('/movies/Film', '/movies/Film/../Other/a.srt')).toBe(false)
    expect(isInside('/movies/Film', '/movies/Film')).toBe(false)
  })
})

// --- Radarr and Sonarr list the extra files -------------------------------------------

const RADARR_URL = 'http://radarr-subs.test:7878'
const SONARR_URL = 'http://sonarr-subs.test:8989'
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function initialized<T extends ArrServerConnector>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return connector
}

const arrOptions = { apiKey: 'a'.repeat(32), source: true, destination: false, autoregister: { enable: false, priority: 1 } }

describe('Radarr getSubtitleFiles', () => {
  test('lists the movie file\'s subtitles (file id 0 included) inside the movie folder and nothing else', async () => {
    const radarr = initialized(new RadarrServerConnector({ ...arrOptions, url: RADARR_URL, name: 'Radarr' }))
    server.use(
      http.get(`${RADARR_URL}/api/v3/movie/7`, () => HttpResponse.json({ id: 7, path: '/movies/Film (2020)', movieFile: { id: 70, path: '/movies/Film (2020)/Film (2020).mkv' } })),
      http.get(`${RADARR_URL}/api/v3/extrafile`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('movieId')).toBe('7')
        return HttpResponse.json([
          { type: 'subtitle', movieFileId: 70, relativePath: 'Film (2020).da.srt', languageTags: ['da'] },
          { type: 'subtitle', movieFileId: 70, relativePath: 'Subs/2_English.srt', languageTags: ['en'] },
          { type: 'subtitle', movieFileId: 0, relativePath: 'Film (2020).sv.srt', languageTags: [] },
          { type: 'metadata', movieFileId: 70, relativePath: 'movie.nfo' },
          { type: 'subtitle', movieFileId: 71, relativePath: 'Film (2020).old.srt' },
          { type: 'subtitle', movieFileId: 70, relativePath: '../../etc/passwd.srt' },
          { type: 'subtitle', movieFileId: 70, relativePath: 'Film (2020).da.txt' },
        ])
      }),
    )
    const found = await radarr.getSubtitleFiles(`${radarr.id}:movie:7`)
    expect(found?.videoPath).toBe('/movies/Film (2020)/Film (2020).mkv')
    expect(found?.files.map(f => f.path)).toEqual(['/movies/Film (2020)/Film (2020).da.srt', '/movies/Film (2020)/Subs/2_English.srt', '/movies/Film (2020)/Film (2020).sv.srt'])
  })

  test('is empty when the extra files can\'t be listed, and null without a movie file', async () => {
    const radarr = initialized(new RadarrServerConnector({ ...arrOptions, url: RADARR_URL, name: 'Radarr' }))
    server.use(
      http.get(`${RADARR_URL}/api/v3/movie/7`, () => HttpResponse.json({ id: 7, path: '/movies/A', movieFile: { id: 70, path: '/movies/A/A.mkv' } })),
      http.get(`${RADARR_URL}/api/v3/movie/8`, () => HttpResponse.json({ id: 8, path: '/movies/B' })),
      http.get(`${RADARR_URL}/api/v3/extrafile`, () => new HttpResponse('boom', { status: 500 })),
    )
    expect((await radarr.getSubtitleFiles(`${radarr.id}:movie:7`))?.files).toEqual([])
    expect(await radarr.getSubtitleFiles(`${radarr.id}:movie:8`)).toBeNull()
  })
})

describe('Sonarr getSubtitleFiles', () => {
  test('keeps the series\' subtitles that belong to the episode\'s file, by id or else by name', async () => {
    const sonarr = initialized(new SonarrServerConnector({ ...arrOptions, url: SONARR_URL, name: 'Sonarr' }))
    server.use(
      http.get(`${SONARR_URL}/api/v3/episode/11`, () => HttpResponse.json({ id: 11, seriesId: 3, episodeFileId: 110 })),
      http.get(`${SONARR_URL}/api/v3/series/3`, () => HttpResponse.json({ id: 3, path: '/tv/Show' })),
      http.get(`${SONARR_URL}/api/v3/episodefile/110`, () => HttpResponse.json({ id: 110, path: '/tv/Show/Season 1/Show - S01E01.mkv' })),
      http.get(`${SONARR_URL}/api/v3/extrafile`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('seriesId')).toBe('3')
        return HttpResponse.json([
          { type: 'subtitle', episodeFileId: 110, relativePath: 'Season 1/Show - S01E01.da.srt' },
          { type: 'subtitle', episodeFileId: 111, relativePath: 'Season 1/Show - S01E02.da.srt' },
          { type: 'subtitle', episodeFileId: 0, relativePath: 'Season 1/Show - S01E01.en.srt' },
          { type: 'subtitle', episodeFileId: 0, relativePath: 'Season 1/Show - S01E02.en.srt' },
        ])
      }),
    )
    const found = await sonarr.getSubtitleFiles(`${sonarr.id}:episode:11`)
    expect(found?.files.map(f => f.path)).toEqual(['/tv/Show/Season 1/Show - S01E01.da.srt', '/tv/Show/Season 1/Show - S01E01.en.srt'])
  })
})

// --- The peer API serves them ---------------------------------------------------------

function fakeSource(videoPath: string, files: string[]) {
  return {
    id: 'src',
    name: 'Radarr',
    type: 'radarr',
    canSource: true,
    getSubtitleFiles: async (id: string) => (id === 'src:movie:1' ? { videoPath, files: files.map(path => ({ path })) } : null),
  } as unknown as ArrServerConnector
}

describe('peer subtitle routes', () => {
  async function setup(paused = false) {
    const video = join(tempDir, 'Film.mkv')
    await writeFile(video, 'video')
    await writeFile(join(tempDir, 'Film.da.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHej\n')
    await writeFile(join(tempDir, 'Film.en.srt'), 'english')
    const controller = new PeerController(() => [fakeSource(video, [join(tempDir, 'Film.da.srt'), join(tempDir, 'Film.en.srt'), join(tempDir, 'gone.srt')])])
    const transfers = {
      monitor: {} as any,
      uploadLimiter: {} as any,
      ledger: { add: () => {} } as any,
      uploadRefusal: (_party?: string, _resume?: string, options?: { ignoreSlots?: boolean }) => {
        expect(options?.ignoreSlots).toBe(true)
        return paused ? { status: 503 as const, retryAfterSeconds: 60, message: 'Sharing is paused' } : null
      },
    }
    return getPeerRouter(controller, transfers)
  }

  test('lists suffixes and sizes, leaving out missing files', async () => {
    const app = await setup()
    const res = await app.request('/items/src:movie:1/subtitles')
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ index: number, suffix: string, size: number }> }
    expect(body.items.map(i => i.suffix)).toEqual(['.da.srt', '.en.srt'])
    expect(body.items[0]!.size).toBeGreaterThan(0)
    expect(body.items.some(i => 'path' in i)).toBe(false)
  })

  test('serves a listed file and refuses unknown items and indexes', async () => {
    const app = await setup()
    const ok = await app.request('/items/src:movie:1/subtitles/1')
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('english')
    expect((await app.request('/items/src:movie:1/subtitles/9')).status).toBe(404)
    expect((await app.request('/items/src:movie:1/subtitles/x')).status).toBe(404)
    expect((await app.request('/items/other:movie:1/subtitles')).status).toBe(404)
  })

  test('follows a pause of sharing', async () => {
    const app = await setup(true)
    expect((await app.request('/items/src:movie:1/subtitles/0')).status).toBe(503)
  })
})

describe('PeerController.subtitles', () => {
  test('leaves out files above the size limit', async () => {
    const video = join(tempDir, 'Film.mkv')
    const big = join(tempDir, 'Film.da.sup')
    await writeFile(big, '')
    await Bun.$`truncate -s ${MAX_SUBTITLE_BYTES + 1} ${big}`.quiet()
    const controller = new PeerController(() => [fakeSource(video, [big])])
    expect(await controller.subtitles('src:movie:1')).toEqual([])
  })
})

// --- The downloading jack fetches and cleans them up -----------------------------------

const release: Release = { id: 'remote:movie:1', title: 'Film.2020.1080p', filename: 'Film.2020.1080p.mkv', category: 2000, size: 5 }

function downloadsConfig(completedPath: string) {
  return {
    completedPath,
    maxConcurrentDownloads: 2,
    maxDownloadAttempts: 2,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    idleTimeoutMs: 60_000,
    importPollIntervalMs: 30_000,
    maxManualImportAttempts: 6,
    manualImportBackoffBaseMs: 60_000,
    manualImportBackoffMaxMs: 1_800_000,
    unlinkImportedFiles: false,
  }
}

async function waitForStatus(repository: DownloadsRepository, status: string) {
  for (let i = 0; i < 100 && repository.list()[0]?.status !== status; i++)
    await Bun.sleep(10)
}

describe('DownloadsService subtitles', () => {
  test('puts the peer\'s subtitle files next to the file before the import is queued', async () => {
    const completedPath = join(tempDir, 'completed')
    await Bun.$`mkdir -p ${completedPath}`.quiet()
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const statusWhenFetched: string[] = []
    const peer = {
      id: 'peer-1',
      name: 'Bob',
      url: 'http://bob.test',
      getRelease: async () => release,
      downloadFile: async (_itemId: string, destPath: string, options: any) => {
        await options.onProgress({ type: 'completed', downloadedBytes: 5, expectedBytes: 5 })
        await Bun.write(destPath, 'video')
      },
      getSubtitles: async () => [
        { index: 0, suffix: '.da.srt', size: 3 },
        { index: 1, suffix: '/../../escape.srt', size: 3 },
        { index: 2, suffix: '.en.srt', size: MAX_SUBTITLE_BYTES + 1 },
        { index: 3, suffix: '.sv.srt', size: 3 },
      ],
      downloadSubtitle: async (_itemId: string, index: number, destPath: string) => {
        statusWhenFetched.push(repository.list()[0]!.status)
        if (index === 3)
          throw new Error('peer went away')
        await Bun.write(destPath, `sub${index}`)
        return 4
      },
    }
    const service = new DownloadsService(downloadsConfig(completedPath), { peers: [peer as any] }, repository)
    await service.startQbDownload({ peerId: 'peer-1', itemId: 'remote:movie:1', qbCategory: 'x', qbSourceServer: 'Radarr', sourceServerId: 'r' })
    await waitForStatus(repository, 'import_queued')

    const row = repository.list()[0]!
    expect(row.status).toBe('import_queued')
    expect(statusWhenFetched).toEqual(['downloading', 'downloading'])
    expect(await Bun.file(join(completedPath, 'Film.2020.1080p.da.srt')).text()).toBe('sub0')
    expect(await Bun.file(join(completedPath, 'Film.2020.1080p.sv.srt')).exists()).toBe(false)
    expect(await Bun.file(join(tempDir, 'escape.srt')).exists()).toBe(false)

    // Deleting the download removes its subtitle files with it.
    await service.delete(row.id)
    expect(await Bun.file(join(completedPath, 'Film.2020.1080p.da.srt')).exists()).toBe(false)
    handle.close()
  })

  test('a peer that lists no subtitles (an older jack) still completes the download', async () => {
    const completedPath = join(tempDir, 'completed')
    await Bun.$`mkdir -p ${completedPath}`.quiet()
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const peer = {
      id: 'peer-1',
      name: 'Bob',
      url: 'http://bob.test',
      getRelease: async () => release,
      downloadFile: async (_itemId: string, destPath: string) => {
        await Bun.write(destPath, 'video')
      },
      getSubtitles: async () => null,
    }
    const service = new DownloadsService(downloadsConfig(completedPath), { peers: [peer as any] }, repository)
    await service.startQbDownload({ peerId: 'peer-1', itemId: 'remote:movie:1', qbCategory: 'x', qbSourceServer: 'Radarr', sourceServerId: 'r' })
    await waitForStatus(repository, 'import_queued')
    expect(repository.list()[0]?.status).toBe('import_queued')
    handle.close()
  })
})

describe('unlinkSubtitleSiblings', () => {
  test('removes only subtitle files named after the file, inside the completed folder', async () => {
    const completedPath = join(tempDir, 'completed')
    await Bun.$`mkdir -p ${completedPath}`.quiet()
    const video = join(completedPath, 'Film.mkv')
    for (const name of ['Film.da.srt', 'Film.en.forced.ass', 'Film.nfo', 'Film2.da.srt', 'Other.da.srt'])
      await writeFile(join(completedPath, name), 'x')
    expect(await unlinkSubtitleSiblings(video, completedPath)).toBe(2)
    const left = (await Array.fromAsync(new Bun.Glob('*').scan(completedPath))).sort()
    expect(left).toEqual(['Film.nfo', 'Film2.da.srt', 'Other.da.srt'])
    expect(await unlinkSubtitleSiblings(join(tempDir, 'Film.mkv'), completedPath)).toBe(0)
  })
})

describe('PeerConnector subtitles', () => {
  const PEER_URL = 'http://peer-subs.test'

  async function makePeer() {
    const { PeerConnector } = await import('../lib/servers/peer')
    const peer = new PeerConnector({ url: PEER_URL, apiKey: 'k'.repeat(32), name: 'Bob' })
    const c = peer as any
    c._isInitialized = true
    c._initState = 'initialized'
    c._initialization.resolve()
    return peer
  }

  test('an older jack without the route lists no subtitles', async () => {
    server.use(http.get(`${PEER_URL}/peer/items/:id/subtitles`, () => new HttpResponse('Not Found', { status: 404 })))
    expect(await (await makePeer()).getSubtitles('remote:movie:1')).toBeNull()
  })

  test('downloads a subtitle file into place and refuses one that is too large', async () => {
    server.use(
      http.get(`${PEER_URL}/peer/items/:id/subtitles`, () => HttpResponse.json({ items: [{ index: 0, suffix: '.da.srt', size: 4 }] })),
      http.get(`${PEER_URL}/peer/items/:id/subtitles/0`, () => new HttpResponse('Hej!', { headers: { 'Content-Length': '4' } })),
      http.get(`${PEER_URL}/peer/items/:id/subtitles/1`, () => new HttpResponse('x', { headers: { 'Content-Length': String(MAX_SUBTITLE_BYTES + 1) } })),
    )
    const peer = await makePeer()
    expect(await peer.getSubtitles('remote:movie:1')).toEqual([{ index: 0, suffix: '.da.srt', size: 4 }])
    const dest = join(tempDir, 'Film.da.srt')
    expect(await peer.downloadSubtitle('remote:movie:1', 0, dest)).toBe(4)
    expect(await Bun.file(dest).text()).toBe('Hej!')
    expect(await Bun.file(`${dest}.part`).exists()).toBe(false)
    await expect(peer.downloadSubtitle('remote:movie:1', 1, join(tempDir, 'big.srt'))).rejects.toThrow('larger than')
  })
})
