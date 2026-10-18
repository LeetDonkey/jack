import { describe, expect, test } from 'bun:test'
import { BandwidthConfig } from '../../lib/config'
import { NOT_PAUSED, pauseState, secondsUntilResume } from './pause'
import { TransferMonitor } from './transfer-monitor'
import { followDownloadsPause, TransferPauses } from './transfer-pauses'
import { getTransfersRouter } from './transfers.router'
import { TransfersService } from './transfers.service'

const NOW = new Date('2026-10-18T12:00:00.000Z')

describe('pauseState', () => {
  test('a future time pauses until then, a past one or nothing doesn\'t', () => {
    expect(pauseState('2026-10-18T13:00:00+01:00', NOW)).toEqual(NOT_PAUSED)
    expect(pauseState('2026-10-18T14:00:00+01:00', NOW)).toEqual({ paused: true, until: '2026-10-18T13:00:00.000Z', indefinite: false })
    expect(pauseState('indefinite', NOW)).toEqual({ paused: true, until: null, indefinite: true })
    expect(pauseState(null, NOW)).toEqual(NOT_PAUSED)
    expect(pauseState('not a time', NOW)).toEqual(NOT_PAUSED)
  })

  test('secondsUntilResume rounds up and is null without an end', () => {
    expect(secondsUntilResume(pauseState('2026-10-18T12:00:00.500Z', NOW), NOW)).toBe(1)
    expect(secondsUntilResume(pauseState('2026-10-18T13:00:00Z', NOW), NOW)).toBe(3600)
    expect(secondsUntilResume(pauseState('indefinite', NOW), NOW)).toBeNull()
  })
})

describe('TransfersService pauses', () => {
  test('paused sharing refuses uploads with 503 and a Retry-After of at most 60 seconds', () => {
    let now = NOW
    let bandwidth = BandwidthConfig.parse({ pausedUntil: '2026-10-18T13:00:00Z' })
    const service = new TransfersService(() => bandwidth, () => null, { now: () => now })

    expect(service.uploadRefusal('key:1')).toEqual({ status: 503, retryAfterSeconds: 60, message: 'Sharing is paused' })
    now = new Date('2026-10-18T12:59:30Z')
    expect(service.uploadRefusal('key:1')?.retryAfterSeconds).toBe(30)

    bandwidth = BandwidthConfig.parse({ pausedUntil: 'indefinite' })
    expect(service.uploadRefusal()).toMatchObject({ status: 503, retryAfterSeconds: 60 })

    now = new Date('2026-10-18T13:00:00Z')
    bandwidth = BandwidthConfig.parse({ pausedUntil: '2026-10-18T13:00:00Z' })
    expect(service.uploadRefusal('key:1')).toBeNull()
  })

  test('lets the next window of an upload that was running through the pause, for a few seconds', () => {
    let now = NOW
    let bandwidth: BandwidthConfig | undefined
    const monitor = new TransferMonitor({ setInterval: () => 0 as any, clearInterval: () => {} }, () => now)
    const service = new TransfersService(() => bandwidth, () => null, { now: () => now, monitor })
    const key = 'key:1:remote1:movie:1'
    const window = monitor.start({ direction: 'upload', peer: 'Nicklas', filename: 'Movie.mkv', totalBytes: 200, offsetBytes: 0, party: 'key:1', resumeKey: key })
    bandwidth = BandwidthConfig.parse({ pausedUntil: 'indefinite' })

    expect(service.uploadRefusal('key:1', key)).toBeNull()
    window.end()
    expect(service.uploadRefusal('key:1', key)).toBeNull()
    expect(service.uploadRefusal('key:1', 'key:1:remote1:movie:2')?.message).toBe('Sharing is paused')
    expect(service.uploadRefusal('key:1')?.message).toBe('Sharing is paused')

    now = new Date(NOW.getTime() + 10_000)
    expect(service.uploadRefusal('key:1', key)?.message).toBe('Sharing is paused')
  })

  test('reports both pauses in the snapshot and tells listeners when one starts and ends by itself', () => {
    let now = NOW
    let downloadsPausedUntil: string | null = null
    const service = new TransfersService(() => undefined, () => 3, { now: () => now, downloadsPausedUntil: () => downloadsPausedUntil })
    const changes: Array<[string, boolean]> = []
    let notified = 0
    service.onPauseChange((target, state) => changes.push([target, state.paused]))
    service.subscribe(() => notified++)

    expect(service.snapshot().paused).toEqual({ uploads: NOT_PAUSED, downloads: NOT_PAUSED })

    downloadsPausedUntil = '2026-10-18T12:30:00Z'
    service.refresh()
    expect(service.snapshot().paused.downloads).toEqual({ paused: true, until: '2026-10-18T12:30:00.000Z', indefinite: false })
    expect(changes).toEqual([['downloads', true]])

    service.refresh()
    expect(changes).toHaveLength(1)

    now = new Date('2026-10-18T12:30:01Z')
    service.refresh()
    expect(changes).toEqual([['downloads', true], ['downloads', false]])
    expect(notified).toBe(2)
  })

  test('a saved downloads pause applies at boot and ends on time when it ends before the first check', () => {
    let now = NOW
    const timeouts: Array<{ fn: () => void, ms: number }> = []
    const timers = {
      setInterval: () => 1 as any,
      clearInterval: () => {},
      setTimeout: (fn: () => void, ms: number) => {
        timeouts.push({ fn, ms })
        return timeouts.length as any
      },
      clearTimeout: () => {},
    }
    const service = new TransfersService(() => undefined, () => 3, {
      now: () => now,
      timers,
      downloadsPausedUntil: () => '2026-10-18T12:00:05Z',
    })
    const paused: boolean[] = []
    const changes: boolean[] = []
    followDownloadsPause(service, { setPaused: p => void paused.push(p) })
    service.onPauseChange((_, state) => changes.push(state.paused))
    expect(paused).toEqual([true])

    service.start()
    expect(timeouts.map(t => t.ms)).toEqual([5000])

    now = new Date('2026-10-18T12:00:05Z')
    timeouts[0]!.fn()
    expect(changes).toEqual([false])
    expect(paused).toEqual([true, false])
    service.stop()
  })
})

describe('TransferPauses', () => {
  function setup({ downloads = true }: { downloads?: boolean } = {}) {
    const stored: { bandwidth: string | null, downloads: string | null } = { bandwidth: null, downloads: null }
    // Blocks as the config file has them: no bandwidth block until one is written.
    let bandwidthBlock: { pausedUntil?: string } | undefined
    const downloadsBlock: { completedPath: string, pausedUntil?: string } | null = downloads ? { completedPath: '/data' } : null
    const writes: string[] = []
    const store = {
      updateBandwidth: async ({ pausedUntil }: { pausedUntil: string | null }) => {
        writes.push('bandwidth')
        stored.bandwidth = pausedUntil
        bandwidthBlock = { ...bandwidthBlock, pausedUntil: pausedUntil ?? undefined }
      },
      updateDownloads: async ({ pausedUntil }: { pausedUntil: string | null }) => {
        writes.push('downloads')
        stored.downloads = pausedUntil
        if (downloadsBlock)
          downloadsBlock.pausedUntil = pausedUntil ?? undefined
      },
      getBandwidth: () => bandwidthBlock,
      getRawDownloads: () => downloadsBlock,
    }
    const service = new TransfersService(
      () => BandwidthConfig.parse({ pausedUntil: stored.bandwidth }),
      () => 3,
      { now: () => NOW, downloadsPausedUntil: () => stored.downloads },
    )
    const pauses = new TransferPauses(store, service, () => NOW)
    return { stored, writes, service, pauses, app: getTransfersRouter(service, pauses) }
  }

  test('POST /pause saves the pause and answers both states', async () => {
    const { app, stored } = setup()
    const res = await app.request('/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'uploads', until: '2026-10-18T16:00:00+02:00' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      paused: { uploads: { paused: true, until: '2026-10-18T14:00:00.000Z', indefinite: false }, downloads: NOT_PAUSED },
    })
    expect(stored.bandwidth).toBe('2026-10-18T16:00:00+02:00')

    const indefinite = await app.request('/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'downloads', until: 'indefinite' }) })
    expect(((await indefinite.json()) as any).paused.downloads).toEqual({ paused: true, until: null, indefinite: true })
  })

  test('refuses a time in the past, a time without offset, and downloads when they are off', async () => {
    await expect(setup().pauses.pause('uploads', '2026-10-18T11:00:00Z')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'until' })

    const noOffset = await setup().app.request('/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'uploads', until: '2026-10-18T16:00:00' }) })
    expect(noOffset.status).toBe(400)

    await expect(setup({ downloads: false }).pauses.pause('downloads', 'indefinite')).rejects.toThrow('Downloads are off')
  })

  test('POST /resume ends one pause, or both without a body', async () => {
    const { app, stored, pauses } = setup()
    await pauses.pause('uploads', 'indefinite')
    await pauses.pause('downloads', 'indefinite')

    const one = await app.request('/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'downloads' }) })
    expect(((await one.json()) as any).paused).toEqual({ uploads: { paused: true, until: null, indefinite: true }, downloads: NOT_PAUSED })
    expect(stored).toEqual({ bandwidth: 'indefinite', downloads: null })

    const both = await app.request('/resume', { method: 'POST' })
    expect(both.status).toBe(200)
    expect(stored).toEqual({ bandwidth: null, downloads: null })

    const bad = await app.request('/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'everything' }) })
    expect(bad.status).toBe(400)
  })

  test('resuming what isn\'t paused writes nothing, so no bandwidth block appears', async () => {
    const { app, writes, pauses } = setup()
    expect((await app.request('/resume', { method: 'POST' })).status).toBe(200)
    await pauses.resume('uploads')
    expect(writes).toEqual([])

    await pauses.pause('downloads', 'indefinite')
    await pauses.resume()
    expect(writes).toEqual(['downloads', 'downloads'])
  })
})
