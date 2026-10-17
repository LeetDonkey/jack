import type { NotificationsConfig } from '../lib/config'
import type { PeerConnector } from '../lib/servers/peer'
import type { DownloadRecord } from '../modules/downloads/downloads.repository'
import type { PeerHealthEvent } from '../modules/friends/peer-health'
import { describe, expect, test } from 'bun:test'
import { NotificationsConfig as NotificationsSchema } from '../lib/config'
import { friendsSnapshot } from '../modules/friends/friends.router'
import { PeerHealthMonitor } from '../modules/friends/peer-health'
import { buildDailySummary } from '../modules/notifications/daily-summary'
import { NotificationsService } from '../modules/notifications/notifications.service'

function fakePeer(ping: () => Promise<unknown>): PeerConnector {
  return { id: 'p1', name: 'Nicklas', url: 'https://jack.example', ping } as unknown as PeerConnector
}

describe('PeerHealthMonitor', () => {
  test('reports reachability and version, announces a long outage once and the return', async () => {
    let now = Date.parse('2026-10-17T10:00:00Z')
    let up = true
    const peer = fakePeer(async () => {
      if (!up)
        throw new Error('connect ECONNREFUSED')
      return { name: 'jack', version: '0.1.0' }
    })
    const events: PeerHealthEvent[] = []
    const monitor = new PeerHealthMonitor(() => [peer], () => 60 * 60_000, () => new Date(now))
    monitor.onEvent(e => events.push(e))

    await monitor.checkAll()
    expect(monitor.list()[0]).toMatchObject({ online: true, version: '0.1.0', lastSeenAt: '2026-10-17T10:00:00.000Z' })

    up = false
    for (const minutes of [5, 30, 65, 70]) {
      now = Date.parse('2026-10-17T10:00:00Z') + minutes * 60_000
      await monitor.checkAll()
    }
    expect(monitor.list()[0]).toMatchObject({ online: false, offlineSince: '2026-10-17T10:05:00.000Z', lastError: 'connect ECONNREFUSED' })
    expect(events.map(e => [e.type, e.offlineMinutes])).toEqual([['offline', 60]])

    up = true
    now += 10 * 60_000
    await monitor.checkAll()
    expect(events.map(e => e.type)).toEqual(['offline', 'back'])
    expect(monitor.list()[0]).toMatchObject({ online: true, offlineSince: null })
  })

  test('a short outage is not announced', async () => {
    let now = 0
    let up = false
    const events: PeerHealthEvent[] = []
    const monitor = new PeerHealthMonitor(() => [fakePeer(async () => {
      if (!up)
        throw new Error('down')
      return {}
    })], () => 60 * 60_000, () => new Date(now))
    monitor.onEvent(e => events.push(e))

    await monitor.checkAll()
    now += 20 * 60_000
    up = true
    await monitor.checkAll()

    expect(events).toEqual([])
  })
})

describe('NotificationsService', () => {
  function service(config: Partial<NotificationsConfig>, now = new Date('2026-10-17T07:00:00Z')) {
    const sent: Array<{ url: string, init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return new Response(null, { status: url.includes('broken') ? 500 : 204 })
    }) as unknown as typeof fetch
    const parsed = NotificationsSchema.parse(config)
    return { notifications: new NotificationsService(() => parsed, fetchImpl, () => now), sent }
  }

  test('formats each webhook type and counts only the ones that accepted', async () => {
    const { notifications, sent } = service({
      webhooks: [
        { type: 'discord', url: 'https://discord.test/hook' },
        { type: 'ntfy', url: 'https://ntfy.test/jack' },
        { type: 'json', url: 'https://ha.test/broken' },
      ],
    })

    const delivered = await notifications.send({ event: 'download-failed', title: 'Download failed: Æblet 🍎.mkv', message: 'From Nicklas: gone' })

    expect(delivered).toBe(2)
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ content: '**Download failed: Æblet 🍎.mkv**\nFrom Nicklas: gone' })
    expect((sent[1]!.init.headers as Record<string, string>).Title).toBe('Download failed: Æblet .mkv')
    expect(sent[1]!.init.body).toBe('From Nicklas: gone')
    expect(JSON.parse(sent[2]!.init.body as string)).toMatchObject({ event: 'download-failed', at: '2026-10-17T07:00:00.000Z' })
  })

  test('sends nothing for an event that is switched off, or without webhooks', async () => {
    const off = service({ webhooks: [{ type: 'json', url: 'https://ha.test/a' }], peerOffline: false })
    expect(await off.notifications.send({ event: 'peer-offline', title: 't', message: 'm' })).toBe(0)
    expect(off.sent).toEqual([])

    const none = service({})
    expect(await none.notifications.send({ event: 'test', title: 't', message: 'm' })).toBe(0)
  })

  test('sends the daily summary once, at or after its time', async () => {
    let now = new Date(2026, 9, 17, 7, 59)
    const sent: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(init.body as string)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const config = NotificationsSchema.parse({ webhooks: [{ type: 'ntfy', url: 'https://ntfy.test/jack' }], dailySummaryAt: '08:00' })
    const notifications = new NotificationsService(() => config, fetchImpl, () => now)
    const build = () => ({ event: 'daily-summary' as const, title: 'jack today', message: 'summary' })

    expect(await notifications.maybeSendSummary(build)).toBe(false)
    now = new Date(2026, 9, 17, 8, 0)
    expect(await notifications.maybeSendSummary(build)).toBe(true)
    now = new Date(2026, 9, 17, 9, 0)
    expect(await notifications.maybeSendSummary(build)).toBe(false)
    now = new Date(2026, 9, 18, 8, 1)
    expect(await notifications.maybeSendSummary(build)).toBe(true)
    expect(sent).toEqual(['summary', 'summary'])
  })
})

describe('buildDailySummary', () => {
  test('lists traffic per friend and today\'s download outcomes', () => {
    const now = new Date(2026, 9, 17, 20, 0)
    const today = new Date(2026, 9, 17, 12, 0).toISOString()
    const yesterday = new Date(2026, 9, 16, 12, 0).toISOString()
    const downloads = [
      { status: 'imported', completedAt: today, updatedAt: today },
      { status: 'import_queued', completedAt: yesterday, updatedAt: yesterday },
      { status: 'failed', completedAt: null, updatedAt: today },
      { status: 'downloading', completedAt: null, updatedAt: today },
    ] as DownloadRecord[]

    const summary = buildDailySummary([
      { direction: 'in', party: 'peer:a', label: 'Nicklas', bytes: 12.5 * 1024 ** 3 },
      { direction: 'out', party: 'key:1', label: 'Nicklas', bytes: 3 * 1024 ** 3 },
    ], downloads, now)

    expect(summary.message).toBe([
      'Downloaded 12.5 GB from Nicklas',
      'Uploaded 3.0 GB to Nicklas',
      'Downloads: 1 finished, 1 failed, 1 still running',
    ].join('\n'))
  })
})

describe('friendsSnapshot', () => {
  test('joins reachability with traffic per window and the per-friend limits', () => {
    const now = new Date(2026, 9, 17, 12, 0)
    const snapshot = friendsSnapshot({
      health: { list: () => [{ id: 'a', name: 'Nicklas', url: 'u', online: true, version: '0.1.0', lastSeenAt: null, offlineSince: null, lastError: null, checkedAt: null }] },
      ledger: { totalsSince: (day: string) => day === '2026-10-17' ? [{ direction: 'in', party: 'peer:a', label: 'Nicklas', bytes: 5 }] : [{ direction: 'in', party: 'peer:a', label: 'Nicklas', bytes: 50 }, { direction: 'out', party: 'key:1', label: 'Nicklas', bytes: 7 }] },
      monitor: { activeCount: (_d: string, party?: string) => (party === 'key:1' ? 2 : 0) } as any,
      apiKeys: { list: () => [{ id: 1, name: 'Nicklas', expiresAt: null } as any] },
      bandwidth: () => ({ maxConcurrentUploadsPerPeer: 2, schedule: [] } as any),
      now: () => now,
    })

    expect(snapshot.peers[0]).toMatchObject({ name: 'Nicklas', online: true, downloaded: { today: 5, week: 50, month: 50 } })
    expect(snapshot.keys).toEqual([{ id: 1, name: 'Nicklas', expiresAt: null, activeUploads: 2, uploaded: { today: 0, week: 7, month: 7 } }])
    expect(snapshot.limits).toEqual({ maxConcurrentUploadsPerPeer: 2, dailyUploadLimitGiBPerPeer: null })
  })
})
