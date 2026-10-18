import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fsp, { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderCheck } from './folder-check'

let dir: string
let library: string
let completed: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jack-folder-check-'))
  library = join(dir, 'movies')
  completed = join(dir, 'completed')
  await mkdir(library)
  await mkdir(completed)
  await writeFile(join(library, 'Movie.mkv'), 'data')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// Lists a real folder, as an *arr that sees it at the same path would.
async function sameFolder(path: string) {
  return (await readdir(path)).map(name => ({ name, path: join(path, name) }))
}

function arr(overrides: Partial<Record<keyof ArrServerConnector | string, unknown>> = {}): ArrServerConnector {
  return {
    id: 'r1',
    name: 'Radarr',
    type: 'radarr',
    canSource: true,
    canDestination: true,
    isInitialized: true,
    initializationError: null,
    rootFolders: async () => [{ path: library }],
    sampleFilePaths: async () => [join(library, 'Movie.mkv')],
    listFolderFiles: sameFolder,
    ...overrides,
  } as unknown as ArrServerConnector
}

describe('FolderCheck', () => {
  test('passes when jack sees the library and the *arr sees the completed folder, and removes its test file', async () => {
    const report = await new FolderCheck({ servers: () => [arr()], completedPath: () => completed, now: () => new Date('2026-10-18T12:00:00Z') }).run()

    expect(report.ok).toBe(true)
    expect(report.checkedAt).toBe('2026-10-18T12:00:00.000Z')
    expect(report.sources).toEqual([{
      serverId: 'r1',
      name: 'Radarr',
      type: 'radarr',
      status: 'ok',
      message: null,
      rootFolders: [{ path: library, status: 'ok', message: `jack sees Radarr's folder ${library}.` }],
      sampleFiles: [{ path: join(library, 'Movie.mkv'), status: 'ok', message: `jack can read ${join(library, 'Movie.mkv')}.` }],
    }])
    expect(report.completed).toMatchObject({ path: completed, status: 'ok', exists: true, writable: true, destinations: [{ serverId: 'r1', status: 'ok' }] })
    expect(report.completed?.freeBytes).toBeGreaterThan(0)
    expect(await readdir(completed)).toEqual([])
  })

  test('names the missing library folder and the file friends would miss', async () => {
    const report = await new FolderCheck({
      servers: () => [arr({ canDestination: false, rootFolders: async () => [{ path: '/movies' }], sampleFilePaths: async () => ['/movies/Film (2020)/Film.mkv'] })],
      completedPath: () => null,
    }).run()

    expect(report.ok).toBe(false)
    expect(report.completed).toBeNull()
    expect(report.sources[0]!.status).toBe('error')
    expect(report.sources[0]!.rootFolders[0]!.message).toContain('Container Path /movies')
    expect(report.sources[0]!.sampleFiles[0]).toMatchObject({ status: 'error', message: expect.stringContaining('file missing') })
  })

  test('tells a destination that sees nothing from one that sees a different folder', async () => {
    const blind = arr({ id: 'r2', name: 'Radarr 4K', canSource: false, listFolderFiles: async () => [] })
    const other = arr({ id: 's1', name: 'Sonarr', type: 'sonarr', canSource: false, listFolderFiles: async () => [{ name: 'Show.S01E01.mkv', path: `${completed}/Show.S01E01.mkv` }] })
    const report = await new FolderCheck({ servers: () => [blind, other], completedPath: () => completed }).run()

    expect(report.ok).toBe(false)
    expect(report.completed?.status).toBe('error')
    expect(report.completed?.destinations.map(d => [d.name, d.status])).toEqual([['Radarr 4K', 'error'], ['Sonarr', 'error']])
    expect(report.completed?.destinations[0]!.message).toContain('doesn\'t see jack\'s completed folder')
    expect(report.completed?.destinations[1]!.message).toContain('different folder')
    expect(await readdir(completed)).toEqual([])
  })

  test('a missing completed folder, and servers it can\'t ask, are reported without failing the check', async () => {
    const down = arr({ isInitialized: false, initializationError: 'connect ECONNREFUSED' })
    const failing = arr({ id: 'r3', name: 'Broken', rootFolders: async () => {
      throw new Error('500 Internal Server Error')
    } })
    const report = await new FolderCheck({ servers: () => [down, failing], completedPath: () => join(dir, 'missing') }).run()

    expect(report.sources.map(s => [s.name, s.status])).toEqual([['Radarr', 'unknown'], ['Broken', 'unknown']])
    expect(report.sources[1]!.message).toContain('500 Internal Server Error')
    expect(report.completed).toMatchObject({ status: 'error', exists: false, writable: null, destinations: [] })
    expect(report.completed?.message).toContain('Downloads path')
  })

  test('a slow *arr is cut off at the timeout', async () => {
    const slow = arr({ rootFolders: () => new Promise(() => {}), listFolderFiles: () => new Promise(() => {}) })
    // Only the *arr calls are cut short; file system calls keep the default.
    const report = await new FolderCheck({ servers: () => [slow], completedPath: () => completed, timeoutMs: 20, fsTimeoutMs: 10_000, libraryTimeoutMs: 20 }).run()

    expect(report.sources[0]).toMatchObject({ status: 'unknown', message: expect.stringContaining('No answer within') })
    expect(report.completed?.destinations[0]).toMatchObject({ status: 'unknown' })
    expect(await readdir(completed)).toEqual([])
  }, 1000)

  test('a test file written after the timeout is removed once the write ends', async () => {
    // Runs the held-back write; resolves once the file is on disk.
    let finish: (() => Promise<void>) | undefined
    const realWriteFile = fsp.writeFile
    const spy = spyOn(fsp, 'writeFile').mockImplementation(((...args: Parameters<typeof fsp.writeFile>) => new Promise<void>((resolve, reject) => {
      finish = () => {
        const written = realWriteFile(...args)
        written.then(resolve, reject)
        return written
      }
    })) as typeof fsp.writeFile)
    try {
      const report = await new FolderCheck({ servers: () => [arr()], completedPath: () => completed, fsTimeoutMs: 250 }).run()
      expect(report.completed).toMatchObject({ status: 'unknown', writable: null, message: expect.stringContaining('couldn\'t write a test file') })

      await finish!()
      for (let i = 0; i < 100 && (await readdir(completed)).length > 0; i++)
        await Bun.sleep(10)
      expect(await readdir(completed)).toEqual([])
    }
    finally {
      spy.mockRestore()
    }
  })
})
