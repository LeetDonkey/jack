import type { NotificationsConfig } from '../lib/config'
import type { PeerConnector } from '../lib/servers/peer'
import type { DownloadRecord } from '../modules/downloads/downloads.repository'
import type { PeerHealth, PeerHealthEvent } from '../modules/friends/peer-health'
import { describe, expect, spyOn, test } from 'bun:test'
import { NotificationsConfig as NotificationsSchema } from '../lib/config'
import { logger } from '../logger'
import { DOWNLOAD_CANCELLED_MESSAGE } from '../modules/downloads/download-state'
import { friendsSnapshot } from '../modules/friends/friends.router'
import { peerFailedCheckMessage, PeerHealthMonitor, peerHealthNotification } from '../modules/friends/peer-health'
import { buildDailySummary } from '../modules/notifications/daily-summary'
import { NotificationsService } from '../modules/notifications/notifications.service'

function fakePeer(ping: (schema?: unknown, options?: { quiet?: boolean }) => Promise<unknown>, extra: { isInitialized?: boolean, init?: () => void } = {}): PeerConnector {
  return { id: 'p1', name: 'Nicklas', url: 'https://jack.example', ping, isInitialized: true, init: () => {}, ...extra } as unknown as PeerConnector
}

// Never looks a host up: these tests don't care which network error it was.
const classify = async () => 'refused' as const

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
    const monitor = new PeerHealthMonitor(() => [peer], () => 60 * 60_000, () => new Date(now), { classify })
    monitor.onEvent(e => events.push(e))

    await monitor.checkAll()
    expect(monitor.list()[0]).toMatchObject({ online: true, version: '0.1.0', lastSeenAt: '2026-10-17T10:00:00.000Z' })

    up = false
    for (const minutes of [5, 30, 65, 70]) {
      now = Date.parse('2026-10-17T10:00:00Z') + minutes * 60_000
      await monitor.checkAll()
    }
    expect(monitor.list()[0]).toMatchObject({ online: false, offlineSince: '2026-10-17T10:05:00.000Z', lastError: 'connect ECONNREFUSED', lastErrorCode: 'refused' })
    expect(events.map(e => [e.type, e.offlineMinutes])).toEqual([['offline', 60]])
    expect(events[0]!.peer.lastErrorCode).toBe('refused')

    up = true
    now += 10 * 60_000
    await monitor.checkAll()
    expect(events.map(e => e.type)).toEqual(['offline', 'back'])
    expect(monitor.list()[0]).toMatchObject({ online: true, offlineSince: null, lastError: null, lastErrorCode: null })
  })

  test('logs a friend going offline and coming back once, and checks quietly while they are offline', async () => {
    let up = true
    const quiet: boolean[] = []
    const peer = fakePeer(async (_schema, options) => {
      quiet.push(options?.quiet ?? false)
      if (!up)
        throw new Error('The operation timed out.')
      return { version: '0.1.0' }
    })
    const monitor = new PeerHealthMonitor(() => [peer], () => 60 * 60_000, () => new Date(0), { classify: async () => 'timeout' })
    const info = spyOn(logger, 'info')
    const logged = () => info.mock.calls.map(call => call[1]).filter(message => typeof message === 'string' && message.includes('Nicklas'))
    try {
      await monitor.checkAll()
      up = false
      for (let i = 0; i < 3; i++)
        await monitor.checkAll()
      up = true
      await monitor.checkAll()
      await monitor.checkAll()
      // The first failed check logs its error as usual (not quiet); the ones after it don't.
      expect(quiet).toEqual([false, false, true, true, true, false])
      expect(logged()).toEqual([
        'jack can\'t reach Nicklas\'s jack: it didn\'t answer in time. jack checks again every 5 minutes',
        'Nicklas is back online',
      ])
    }
    finally {
      info.mockRestore()
    }
  })

  test('a short outage is not announced', async () => {
    let now = 0
    let up = false
    const events: PeerHealthEvent[] = []
    const monitor = new PeerHealthMonitor(() => [fakePeer(async () => {
      if (!up)
        throw new Error('down')
      return { version: '0.1.0' }
    })], () => 60 * 60_000, () => new Date(now), { classify })
    monitor.onEvent(e => events.push(e))

    await monitor.checkAll()
    now += 20 * 60_000
    up = true
    await monitor.checkAll()

    expect(monitor.list()[0]!.online).toBe(true)
    expect(events).toEqual([])
  })

  test('a peer whose version jack can\'t talk to counts as offline', async () => {
    // The real classifier: an incompatible version needs no DNS lookup.
    const monitor = new PeerHealthMonitor(() => [fakePeer(async () => ({ name: 'jack', version: '0.0.9' }))], () => 60 * 60_000, () => new Date(0))
    await monitor.checkAll()
    expect(monitor.list()[0]).toMatchObject({ online: false, version: '0.0.9', lastErrorCode: 'incompatible' })
  })

  test('the code comes from the classifier, and a failing classifier means unknown', async () => {
    const failing = new PeerHealthMonitor(() => [fakePeer(async () => {
      throw new Error('x')
    })], () => 60 * 60_000, () => new Date(0), { classify: async () => {
      throw new Error('lookup broke')
    } })
    await failing.checkAll()
    expect(failing.list()[0]!.lastErrorCode).toBe('unknown')
  })

  test('connects a peer that answers while its connector never connected', async () => {
    const inits: string[] = []
    const down = fakePeer(async () => ({ version: '0.1.0' }), { isInitialized: false, init: () => inits.push('down') })
    const up = { ...fakePeer(async () => ({ version: '0.1.0' }), { init: () => inits.push('up') }), id: 'p2' } as unknown as PeerConnector
    const monitor = new PeerHealthMonitor(() => [down, up], () => 60 * 60_000, () => new Date(0), { classify })
    await monitor.checkAll()
    expect(inits).toEqual(['down'])
  })

  test('notifies subscribers once per round and once per single check, and shares a running check', async () => {
    let pings = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const peer = fakePeer(async () => {
      pings++
      await gate
      return { version: '0.1.0' }
    })
    const monitor = new PeerHealthMonitor(() => [peer, { ...peer, id: 'p2' } as unknown as PeerConnector], () => 60 * 60_000, () => new Date(0), { classify })
    let notified = 0
    monitor.subscribe(() => notified++)

    const round = monitor.checkAll()
    const single = monitor.check(peer)
    release()
    await Promise.all([round, single])
    // p1's check ran once for both callers, p2 once.
    expect(pings).toBe(2)
    expect(notified).toBe(2)
    expect((await monitor.check(peer)).online).toBe(true)
    expect(notified).toBe(3)
  })

  test('a check of a replaced connector runs first, so the edited peer\'s own result is the one kept', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // The old connector's key is rejected; the edit (same url, so same id) fixed it.
    const old = fakePeer(async () => {
      await gate
      throw new Error('Unauthorized')
    })
    const edited = fakePeer(async () => ({ version: '0.1.0' }))
    let current = old
    const monitor = new PeerHealthMonitor(() => [current], () => 60 * 60_000, () => new Date(0), { classify: async () => 'unauthorized' })

    const round = monitor.checkAll()
    current = edited
    const afterSave = monitor.check(edited)
    release()
    await Promise.all([round, afterSave])
    expect(monitor.list()[0]).toMatchObject({ online: true, lastError: null, lastErrorCode: null })
  })

  test('a failure is written in one go, after it is classified', async () => {
    let up = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const monitor = new PeerHealthMonitor(() => [fakePeer(async () => {
      if (!up)
        throw new Error('refused')
      return { version: '0.1.0' }
    })], () => 60 * 60_000, () => new Date('2026-10-18T10:00:00Z'), { classify: async () => {
      await gate
      return 'dns'
    } })
    await monitor.checkAll()

    up = false
    const failing = monitor.checkAll()
    // While the classifier looks the host up, the last complete state shows.
    await Bun.sleep(0)
    expect(monitor.list()[0]).toMatchObject({ online: true, offlineSince: null, lastErrorCode: null })
    release()
    await failing
    expect(monitor.list()[0]).toMatchObject({ online: false, offlineSince: '2026-10-18T10:00:00.000Z', lastError: 'refused', lastErrorCode: 'dns' })
  })
})

describe('peerHealthNotification', () => {
  const peer = (lastErrorCode: PeerHealth['lastErrorCode'], version: string | null = null): PeerHealth => ({ id: 'p1', name: 'Alice', url: 'https://a.test', online: false, version, build: null, lastSeenAt: null, offlineSince: null, lastError: 'boom', lastErrorCode, checkedAt: null })

  test('says what kind of failure it is, and keeps "hasn\'t reached" for an unreachable peer', () => {
    const offline = (code: PeerHealth['lastErrorCode'], version?: string) => peerHealthNotification({ type: 'offline', peer: peer(code, version), offlineMinutes: 60 })
    expect(offline('incompatible', '0.0.9')).toMatchObject({ event: 'peer-offline', title: 'Alice needs a newer jack' })
    expect(offline('incompatible', '0.0.9').message).toContain('version 0.0.9')
    expect(offline('unauthorized')).toMatchObject({ event: 'peer-offline', title: 'Alice\'s jack rejected your key' })
    expect(offline('unauthorized').message).toContain('Ask Alice for a new link')
    expect(offline('forbidden')).toMatchObject({ event: 'peer-offline', title: 'Alice\'s jack is blocking you' })
    for (const code of ['timeout', 'dns', 'refused', 'tls', 'unavailable', 'unknown', null] as const) {
      const notification = offline(code)
      expect(notification.title).toBe('Alice is offline')
      expect(notification.message).toBe('jack hasn\'t reached Alice for 60 minutes. Downloads from them wait and retry.\nLast error: boom')
    }
    expect(peerHealthNotification({ type: 'back', peer: { ...peer(null), online: true }, offlineMinutes: 75 })).toEqual({ event: 'peer-back', title: 'Alice is back', message: 'Alice answers again after 75 minutes offline.' })
  })
})

describe('peerFailedCheckMessage', () => {
  test('says what went wrong in words, and calls a jack that answered with a refusal neither offline nor unreachable', () => {
    const later = '. jack checks again every 5 minutes'
    expect(peerFailedCheckMessage('Alice', 'unauthorized')).toBe(`Alice's jack rejected your key; ask Alice for a new link${later}`)
    expect(peerFailedCheckMessage('Alice', 'forbidden')).toBe(`Alice's jack is blocking you; ask Alice to check their jack${later}`)
    expect(peerFailedCheckMessage('Alice', 'incompatible')).toBe(`Alice's jack runs a version jack can't talk to; downloads from them wait until Alice updates jack${later}`)
    expect(peerFailedCheckMessage('Alice', 'unavailable')).toBe(`Alice's jack or its proxy answered with an error or cut the connection${later}`)
    expect(peerFailedCheckMessage('Alice', 'timeout')).toBe(`jack can't reach Alice's jack: it didn't answer in time${later}`)
    expect(peerFailedCheckMessage('Alice', 'dns')).toBe(`jack can't reach Alice's jack: the address doesn't resolve${later}`)
    expect(peerFailedCheckMessage('Alice', 'refused')).toBe(`jack can't reach Alice's jack: nothing accepts connections at that address${later}`)
    expect(peerFailedCheckMessage('Alice', 'tls')).toBe(`jack can't reach Alice's jack: its HTTPS certificate was rejected${later}`)
    expect(peerFailedCheckMessage('Alice', 'unknown')).toBe(`jack can't reach Alice's jack${later}`)
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

  test('leaves downloads the user cancelled out of the failed count', () => {
    const now = new Date(2026, 9, 17, 20, 0)
    const today = new Date(2026, 9, 17, 12, 0).toISOString()
    const downloads = [
      { status: 'failed', lastOperation: 'transfer', error: 'Peer download stalled', completedAt: null, updatedAt: today },
      { status: 'failed', lastOperation: 'transfer', error: DOWNLOAD_CANCELLED_MESSAGE, completedAt: null, updatedAt: today },
    ] as DownloadRecord[]

    expect(buildDailySummary([], downloads, now).message).toContain('Downloads: 0 finished, 1 failed, 0 still running')
  })
})

describe('friendsSnapshot', () => {
  test('joins reachability with traffic per window and the per-friend limits', () => {
    const now = new Date(2026, 9, 17, 12, 0)
    const snapshot = friendsSnapshot({
      health: { list: () => [{ id: 'a', name: 'Nicklas', url: 'u', online: true, version: '0.1.0', build: null, lastSeenAt: null, offlineSince: null, lastError: null, lastErrorCode: null, checkedAt: null }] },
      ledger: { totalsSince: (day: string) => day === '2026-10-17' ? [{ direction: 'in', party: 'peer:a', label: 'Nicklas', bytes: 5 }] : [{ direction: 'in', party: 'peer:a', label: 'Nicklas', bytes: 50 }, { direction: 'out', party: 'key:1', label: 'Nicklas', bytes: 7 }] },
      monitor: { activeCount: (_d: string, party?: string) => (party === 'key:1' ? 2 : 0) } as any,
      apiKeys: { list: () => [{ id: 1, name: 'Nicklas', expiresAt: null, createdAt: '2026-10-01T09:00:00.000Z' } as any] },
      bandwidth: () => ({ maxConcurrentUploadsPerPeer: 2, schedule: [] } as any),
      now: () => now,
    })

    expect(snapshot.peers[0]).toMatchObject({ name: 'Nicklas', online: true, identityId: null, downloaded: { today: 5, week: 50, month: 50 } })
    expect(snapshot.keys).toEqual([{ id: 1, name: 'Nicklas', expiresAt: null, activeUploads: 2, uploaded: { today: 0, week: 7, month: 7 }, lastUsedAt: null, lastUsedTrackedSince: '2026-10-01T09:00:00.000Z', peerId: null, origin: null, boundIdentityId: null, boundAt: null }])
    expect(snapshot.limits).toEqual({ maxConcurrentUploadsPerPeer: 2, dailyUploadLimitGiBPerPeer: null })
    // A hand-made key with nothing linking it is not a friend's; its name is a suggestion.
    expect(snapshot.friends.map(f => [f.key, f.state, f.suggestedKeyIds])).toEqual([['peer:a', 'noKey', [1]]])
    expect(snapshot.unlinked.keys.map(k => [k.id, k.suggestedPeerId])).toEqual([[1, 'a']])
  })

  test('links keys to peers by explicit link and by identity, with last use from the key metadata', () => {
    const now = new Date('2026-10-18T12:00:00Z')
    const health = (id: string, name: string) => ({ id, name, url: `https://${id}.test`, online: true, version: '0.1.0', build: null, lastSeenAt: null, offlineSince: null, lastError: null, lastErrorCode: null, checkedAt: null })
    const snapshot = friendsSnapshot({
      health: { list: () => [health('a', 'Alice'), health('b', 'Bob')] },
      apiKeys: { list: () => [{ id: 1, name: 'Alice', expiresAt: null, createdAt: '2026-10-18T11:00:00.000Z' }, { id: 2, name: 'bob-key', expiresAt: null, createdAt: '2026-10-01T11:00:00.000Z' }] as any },
      keyMeta: { all: () => new Map([[1, { keyId: 1, peerId: 'a', origin: 'quick-link' as const, lastUsedAt: '2026-10-18T11:58:00.000Z' }]]), trackingSince: () => '2026-10-18T09:00:00.000Z' },
      identities: {
        peerIdentity: id => (id === 'b' ? 'id-bob' : null),
        keyBindings: () => [{ apiKeyId: 2, identityId: 'id-bob', boundAt: '2026-10-18T10:00:00.000Z' }],
      },
      bandwidth: () => undefined,
      now: () => now,
    })

    expect(snapshot.peers.map(p => p.identityId)).toEqual([null, 'id-bob'])
    expect(snapshot.keys[1]).toMatchObject({ boundIdentityId: 'id-bob', boundAt: '2026-10-18T10:00:00.000Z', lastUsedTrackedSince: '2026-10-18T09:00:00.000Z' })
    // Key 1 was made after usage tracking began: its last use counts from its creation.
    expect(snapshot.keys[0]!.lastUsedTrackedSince).toBe('2026-10-18T11:00:00.000Z')
    expect(snapshot.friends.map(f => [f.key, f.keys.map(k => [k.id, k.link]), f.state])).toEqual([
      ['peer:b', [[2, 'identity']], 'waiting'],
      ['peer:a', [[1, 'explicit']], 'both'],
    ])
    expect(snapshot.unlinked).toEqual({ peers: [], keys: [] })
  })
})
