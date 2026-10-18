import type { Release } from '../../lib/release'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../database/connection'
import { FetchError } from '../../lib/errors/FetchError'
import { TransferMonitor } from '../transfers/transfer-monitor'
import { DOWNLOAD_CANCELLED_MESSAGE, isCancelledByUser } from './download-state'
import { DownloadsRepository } from './downloads.repository'
import { DownloadsService } from './downloads.service'

const release: Release = { id: 'remote:movie:1', title: 'Movie', filename: 'Movie.mkv', category: 2000, size: 10 }

let tempDir: string
let completedPath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-download-phases-'))
  completedPath = join(tempDir, 'completed')
  await Bun.$`mkdir -p ${completedPath}`.quiet()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function config(overrides: Record<string, number> = {}) {
  return {
    completedPath,
    maxConcurrentDownloads: 1,
    maxDownloadAttempts: 3,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    idleTimeoutMs: 60_000,
    importPollIntervalMs: 30_000,
    maxManualImportAttempts: 6,
    manualImportBackoffBaseMs: 60_000,
    manualImportBackoffMaxMs: 1_800_000,
    unlinkImportedFiles: false,
    ...overrides,
  }
}

// downloadFile waits until aborted for 'block', fails for 'fail', finishes otherwise.
function fakePeer(downloadFile?: (itemId: string, options: any) => Promise<void>) {
  return {
    id: 'peer-1',
    name: 'Alice',
    url: 'http://alice.test',
    getRelease: async (itemId: string) => ({ ...release, filename: `${itemId}.mkv` }),
    downloadFile: async (itemId: string, _dest: string, options: any) => {
      if (downloadFile)
        return downloadFile(itemId, options)
      await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
    },
  }
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
}

async function setup(peer: ReturnType<typeof fakePeer>, overrides: Record<string, number> = {}, extras: { monitor?: TransferMonitor, now?: () => number } = {}) {
  const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
  const repository = new DownloadsRepository(handle.db)
  const transfers = extras.monitor ? { monitor: extras.monitor, downloadLimiter: { take: async () => {} }, ledger: undefined } as any : undefined
  const service = new DownloadsService(config(overrides), { peers: [peer as any] }, repository, undefined, transfers, { now: extras.now })
  const start = async (itemId: string) => {
    await service.startQbDownload({ peerId: 'peer-1', itemId, qbCategory: 'x', qbSourceServer: 'Radarr', sourceServerId: 'r' })
    return repository.list().find(row => row.itemId === itemId)!
  }
  return { handle, repository, service, start }
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++)
    await Bun.sleep(5)
}

describe('download phases', () => {
  test('a download waiting for a slot is queued, the one holding it is transferring', async () => {
    const started = Promise.withResolvers<void>()
    const { handle, service, start } = await setup(fakePeer(async (_itemId, options) => {
      started.resolve()
      await untilAborted(options.signal)
    }))
    let changes = 0
    service.subscribe(() => changes++)

    const one = await start('one')
    await started.promise
    const two = await start('two')
    await waitFor(() => service.phaseOf(two.id) !== null)

    expect(service.phaseOf(one.id)).toEqual({ phase: 'transferring', retryAt: null })
    expect(service.phaseOf(two.id)).toEqual({ phase: 'queued', retryAt: null })
    expect(changes).toBeGreaterThan(0)

    await service.cancel(two.id)
    await service.cancel(one.id)
    expect(service.phaseOf(one.id)).toBeNull()
    handle.close()
  }, 2000)

  test('a failed attempt waits as retry_wait with the time of the next attempt', async () => {
    const attempted = Promise.withResolvers<void>()
    const now = Date.parse('2026-10-18T12:00:00.000Z')
    const { handle, service, start } = await setup(fakePeer(async () => {
      attempted.resolve()
      throw new FetchError('busy', new Response(null, { status: 503, headers: { 'Retry-After': '30' } }))
    }), { retryBaseDelayMs: 60_000, retryMaxDelayMs: 60_000 }, { now: () => now })

    const row = await start('one')
    await attempted.promise
    await waitFor(() => service.phaseOf(row.id)?.phase === 'retry_wait')

    expect(service.phaseOf(row.id)).toEqual({ phase: 'retry_wait', retryAt: '2026-10-18T12:00:30.000Z' })
    await service.cancel(row.id)
    handle.close()
  }, 2000)

  test('a cancelled download keeps the cancel message whatever the transfer threw, and counts as cancelled', async () => {
    const started = Promise.withResolvers<void>()
    const { handle, repository, service, start } = await setup(fakePeer(async (_itemId, options) => {
      started.resolve()
      await untilAborted(options.signal).catch(() => {
        throw new TypeError('fetch failed')
      })
    }))

    const row = await start('one')
    await started.promise
    const cancelled = await service.cancel(row.id)

    expect(cancelled).toMatchObject({ status: 'failed', error: DOWNLOAD_CANCELLED_MESSAGE })
    expect(isCancelledByUser(repository.get(row.id)!)).toBe(true)
    // Cancelling again is a no-op.
    expect(await service.cancel(row.id)).toMatchObject({ error: DOWNLOAD_CANCELLED_MESSAGE })
    handle.close()
  }, 2000)

  test('a real failure is not a cancel', async () => {
    const { handle, repository, start } = await setup(fakePeer(async () => {
      throw new FetchError('gone', new Response(null, { status: 404 }))
    }))
    const row = await start('one')
    await waitFor(() => repository.get(row.id)?.status === 'failed')
    expect(isCancelledByUser(repository.get(row.id)!)).toBe(false)
    handle.close()
  }, 2000)

  test('paused downloads stay queued and start when resumed', async () => {
    let calls = 0
    const { handle, repository, service, start } = await setup(fakePeer(async (_itemId, options) => {
      calls++
      await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
    }))
    service.setPaused(true)
    expect(service.isPaused).toBe(true)

    const row = await start('one')
    await Bun.sleep(20)
    expect(calls).toBe(0)
    expect(service.phaseOf(row.id)).toEqual({ phase: 'queued', retryAt: null })

    service.setPaused(false)
    await waitFor(() => repository.get(row.id)?.status === 'import_queued')
    expect(calls).toBe(1)
    expect(service.phaseOf(row.id)).toBeNull()
    handle.close()
  }, 2000)

  test('the live transfer carries the download id', async () => {
    const monitor = new TransferMonitor({ setInterval: () => 0 as any, clearInterval: () => {} })
    let seen: number | null | undefined
    const { handle, start } = await setup(fakePeer(async (_itemId, options) => {
      seen = monitor.list()[0]?.downloadId
      await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
    }), {}, { monitor })

    const row = await start('one')
    await waitFor(() => seen !== undefined)
    expect(seen).toBe(row.id)
    handle.close()
  }, 2000)
})
