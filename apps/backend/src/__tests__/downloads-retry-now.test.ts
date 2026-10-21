import type { Release } from '../lib/release'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../database/connection'
import { ConflictError } from '../lib/errors/ConflictError'
import { FetchError } from '../lib/errors/FetchError'
import { logger } from '../logger'
import { DOWNLOAD_CANCELLED_MESSAGE } from '../modules/downloads/download-state'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { DownloadsService } from '../modules/downloads/downloads.service'

const release: Release = { id: 'remote:movie:1', title: 'Movie', filename: 'Movie.mkv', category: 2000, size: 10 }

let tempDir: string
let completedPath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-downloads-retry-now-'))
  completedPath = join(tempDir, 'completed')
  await Bun.$`mkdir -p ${completedPath}`.quiet()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// A backoff long enough that only retryNow (or a cancel) ends it within a test.
const HOUR = 60 * 60_000

function config(overrides: Record<string, number> = {}) {
  return {
    completedPath,
    maxConcurrentDownloads: 1,
    maxDownloadAttempts: 5,
    retryBaseDelayMs: HOUR,
    retryMaxDelayMs: HOUR,
    idleTimeoutMs: 60_000,
    importPollIntervalMs: 30_000,
    maxManualImportAttempts: 6,
    manualImportBackoffBaseMs: 60_000,
    manualImportBackoffMaxMs: 1_800_000,
    unlinkImportedFiles: false,
    ...overrides,
  }
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
}

// `attempt` decides what each call of downloadFile does; it finishes the file by default.
function fakePeer(attempt: (itemId: string, call: number, options: any) => Promise<void>) {
  const calls = new Map<string, number>()
  const order: string[] = []
  return {
    order,
    peer: {
      id: 'peer-1',
      name: 'Alice',
      url: 'http://alice.test',
      getRelease: async (itemId: string) => ({ ...release, filename: `${itemId}.mkv` }),
      downloadFile: async (itemId: string, _dest: string, options: any) => {
        const call = (calls.get(itemId) ?? 0) + 1
        calls.set(itemId, call)
        order.push(itemId)
        await attempt(itemId, call, options)
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    },
  }
}

const busy = () => new FetchError('busy', new Response(null, { status: 503, headers: { 'Retry-After': '3600' } }))

async function setup(attempt: Parameters<typeof fakePeer>[0], overrides: Record<string, number> = {}) {
  const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
  const repository = new DownloadsRepository(handle.db)
  const { peer, order } = fakePeer(attempt)
  const service = new DownloadsService(config(overrides), { peers: [peer as any] }, repository)
  const start = async (itemId: string) => {
    await service.startQbDownload({ peerId: 'peer-1', itemId, qbCategory: 'x', qbSourceServer: 'Radarr', sourceServerId: 'r' })
    return repository.list().find(row => row.itemId === itemId)!
  }
  return { handle, repository, service, start, order }
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++)
    await Bun.sleep(5)
}

describe('retryNow', () => {
  test('ends the wait, and the next attempt runs at once', async () => {
    const { handle, repository, service, start, order } = await setup(async (_itemId, call) => {
      if (call === 1)
        throw busy()
    })
    const row = await start('one')
    await waitFor(() => service.phaseOf(row.id)?.phase === 'retry_wait')

    service.retryNow(row.id)
    await waitFor(() => repository.get(row.id)?.status === 'import_queued')

    expect(repository.get(row.id)?.status).toBe('import_queued')
    expect(order).toEqual(['one', 'one'])
    handle.close()
  }, 2000)

  test('answers a conflict for a download that isn\'t waiting to retry', async () => {
    const started = Promise.withResolvers<void>()
    const { handle, service, start } = await setup(async (_itemId, _call, options) => {
      started.resolve()
      await untilAborted(options.signal)
    })
    const one = await start('one')
    await started.promise
    const two = await start('two')
    await waitFor(() => service.phaseOf(two.id)?.phase === 'queued')

    expect(() => service.retryNow(one.id)).toThrow(ConflictError)
    expect(() => service.retryNow(two.id)).toThrow(ConflictError)

    await service.cancel(two.id)
    await service.cancel(one.id)
    // Cancelled rows are failed, not waiting.
    expect(() => service.retryNow(one.id)).toThrow(ConflictError)
    expect(() => service.retryNow(9999)).toThrow('not found')
    handle.close()
  }, 2000)

  test('queues the attempt ahead of new downloads, behind the one holding the slot', async () => {
    const holdGate = Promise.withResolvers<void>()
    const { handle, repository, service, start, order } = await setup(async (itemId, call) => {
      if (itemId === 'retrying' && call === 1)
        throw busy()
      if (itemId === 'holder')
        await holdGate.promise
    })
    const retrying = await start('retrying')
    await waitFor(() => service.phaseOf(retrying.id)?.phase === 'retry_wait')
    const holder = await start('holder')
    await waitFor(() => service.phaseOf(holder.id)?.phase === 'transferring')
    const fresh = await start('fresh')
    await waitFor(() => service.phaseOf(fresh.id)?.phase === 'queued')

    service.retryNow(retrying.id)
    await waitFor(() => service.phaseOf(retrying.id)?.phase === 'queued')
    // It waits for the slot like any other download.
    expect(service.phaseOf(retrying.id)).toEqual({ phase: 'queued', retryAt: null })

    holdGate.resolve()
    await waitFor(() => repository.list().every(row => row.status === 'import_queued'))
    expect(order).toEqual(['retrying', 'holder', 'retrying', 'fresh'])
    handle.close()
  }, 2000)

  test('doesn\'t start the attempt while downloads are paused', async () => {
    const { handle, repository, service, start, order } = await setup(async (_itemId, call) => {
      if (call === 1)
        throw busy()
    })
    const row = await start('one')
    await waitFor(() => service.phaseOf(row.id)?.phase === 'retry_wait')
    service.setPaused(true)

    service.retryNow(row.id)
    await waitFor(() => service.phaseOf(row.id)?.phase === 'queued')
    await Bun.sleep(20)
    expect(order).toEqual(['one'])
    expect(service.phaseOf(row.id)).toEqual({ phase: 'queued', retryAt: null })

    service.setPaused(false)
    await waitFor(() => repository.get(row.id)?.status === 'import_queued')
    expect(order).toEqual(['one', 'one'])
    handle.close()
  }, 2000)

  test('a cancel still ends the wait', async () => {
    const { handle, repository, service, start } = await setup(async () => {
      throw busy()
    })
    const row = await start('one')
    await waitFor(() => service.phaseOf(row.id)?.phase === 'retry_wait')

    await service.cancel(row.id)
    expect(repository.get(row.id)).toMatchObject({ status: 'failed', error: DOWNLOAD_CANCELLED_MESSAGE })
    expect(() => service.retryNow(row.id)).toThrow(ConflictError)
    handle.close()
  }, 2000)
})

describe('cancel logging', () => {
  test('a cancel is logged at info, without a stack, and isn\'t announced as a failure', async () => {
    const started = Promise.withResolvers<void>()
    const { handle, service, start } = await setup(async (_itemId, _call, options) => {
      started.resolve()
      await untilAborted(options.signal)
    })
    const failed: string[] = []
    service.onDownloadFailed((_record, error) => failed.push(error))
    const info = spyOn(logger, 'info')
    const error = spyOn(logger, 'error')
    try {
      const row = await start('one')
      await started.promise
      await service.cancel(row.id)

      const cancelLines = info.mock.calls.filter(call => call[1] === DOWNLOAD_CANCELLED_MESSAGE)
      expect(cancelLines).toHaveLength(1)
      expect(cancelLines[0]![0]).not.toHaveProperty('stack')
      expect(error.mock.calls.filter(call => call[1] === 'Download failed')).toHaveLength(0)
      expect(failed).toEqual([])
    }
    finally {
      info.mockRestore()
      error.mockRestore()
      handle.close()
    }
  }, 2000)

  test('a real failure is still logged as an error with its stack', async () => {
    const { handle, repository, start } = await setup(async () => {
      throw new FetchError('gone', new Response(null, { status: 400 }))
    })
    const error = spyOn(logger, 'error')
    try {
      const row = await start('one')
      await waitFor(() => repository.get(row.id)?.status === 'failed')

      const lines = error.mock.calls.filter(call => call[1] === 'Download failed')
      expect(lines).toHaveLength(1)
      expect(lines[0]![0]).toHaveProperty('stack')
    }
    finally {
      error.mockRestore()
      handle.close()
    }
  }, 2000)
})
