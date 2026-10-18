import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { DOWNLOAD_CANCELLED_MESSAGE } from '../downloads/download-state'
import { DownloadsRepository } from '../downloads/downloads.repository'
import { TrafficLedger } from '../transfers/traffic-ledger'
import { StatusController } from './status.controller'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0))
    db.close()
})

function repository() {
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  const db = drizzle({ client: sqlite, schema })
  runMigrations(db)
  return { sqlite, repo: new DownloadsRepository(db) }
}

function row(repo: DownloadsRepository, itemId: string) {
  return repo.create({
    torrentFilename: `${itemId}.torrent`,
    peerId: 'p1',
    peerName: 'Alice',
    itemId,
    filename: `${itemId}.mkv`,
    destPath: `/data/${itemId}.mkv`,
    partPath: `/data/${itemId}.mkv.part`,
    releaseSize: 100,
    release: { id: itemId, title: itemId, filename: `${itemId}.mkv`, category: 2000, size: 100 },
  })
}

describe('overview downloads', () => {
  test('a cancelled download is counted as cancelled, not failed, and running ones per phase', () => {
    const { sqlite, repo } = repository()
    const queued = row(repo, 'queued')
    const transferring = row(repo, 'transferring')
    const waiting = row(repo, 'waiting')
    const cancelled = row(repo, 'cancelled')
    const failed = row(repo, 'failed')
    repo.markFailed(cancelled.id, DOWNLOAD_CANCELLED_MESSAGE)
    repo.markFailed(failed.id, 'Peer answered 404')

    const phases = new Map([
      [queued.id, { phase: 'queued' as const, retryAt: null }],
      [transferring.id, { phase: 'transferring' as const, retryAt: null }],
      [waiting.id, { phase: 'retry_wait' as const, retryAt: '2026-10-18T12:30:00.000Z' }],
    ])
    const ledger = new TrafficLedger(sqlite, () => new Date(2026, 9, 18, 12))
    ledger.add('out', 'key:1', 'Alice', 300)
    ledger.add('in', 'peer:p1', 'Alice', 200)
    const controller = new StatusController({ servers: [], peers: [] }, repo, {
      downloadPhases: { phaseOf: id => phases.get(id) ?? null, subscribe: () => () => {} },
      traffic: ledger,
    })

    const { downloads, lifetime } = controller.getOverview()

    expect(downloads.byStatus).toMatchObject({ downloading: 3, failed: 1 })
    expect(downloads.cancelled).toBe(1)
    expect(downloads.byPhase).toEqual({ queued: 1, transferring: 1, retry_wait: 1 })
    expect(downloads.failed.map(d => d.itemId)).toEqual(['failed'])
    expect(downloads.active.find(d => d.itemId === 'waiting')).toMatchObject({ phase: 'retry_wait', retryAt: '2026-10-18T12:30:00.000Z', cancelledByUser: false })
    expect(lifetime).toEqual({ downloadedBytes: 200, uploadedBytes: 300, since: '2026-10-18' })

    const listed = controller.listDownloads().downloads
    expect(listed.find(d => d.itemId === 'cancelled')).toMatchObject({ status: 'failed', cancelledByUser: true, phase: null, retryAt: null })
  })

  test('without a downloads service rows have no phase, and lifetime is zero', () => {
    const { repo } = repository()
    row(repo, 'stale')
    const controller = new StatusController({ servers: [], peers: [] }, repo)
    const overview = controller.getOverview()
    expect(overview.downloads.active[0]).toMatchObject({ phase: null, retryAt: null, cancelledByUser: false })
    expect(overview.lifetime).toEqual({ downloadedBytes: 0, uploadedBytes: 0, since: null })
  })

  test('the downloads stream follows phase changes too', () => {
    const { repo } = repository()
    const subscribers: Array<() => void> = []
    const controller = new StatusController({ servers: [], peers: [] }, repo, {
      downloadPhases: { phaseOf: () => null, subscribe: (fn) => {
        subscribers.push(fn)
        return () => {}
      } },
    })
    let calls = 0
    controller.subscribeDownloads(() => calls++)
    subscribers.forEach(fn => fn())
    expect(calls).toBe(1)
  })
})
