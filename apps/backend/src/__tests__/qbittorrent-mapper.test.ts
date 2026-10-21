import type { DownloadRecord } from '../modules/downloads/downloads.repository'
import { describe, expect, test } from 'bun:test'
import { DOWNLOAD_CANCELLED_MESSAGE } from '../modules/downloads/download-state'
import { deriveHash, toQbTorrent } from '../modules/qbittorrent/qbittorrent.mapper'

function baseRecord(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 1,
    torrentFilename: 'movie.torrent',
    peerId: 'peer0001',
    peerName: 'Peer',
    itemId: 'conn:movie:42',
    filename: 'Big Buck Bunny (2008).mkv',
    destPath: '/tmp/completed/Big Buck Bunny (2008).mkv',
    partPath: '/tmp/completed/Big Buck Bunny (2008).mkv.part',
    releaseSize: 10,
    release: { id: 'conn:movie:42', title: 'Big Buck Bunny', filename: 'Big Buck Bunny (2008).mkv', category: 2000, size: 10 } as any,
    expectedBytes: null,
    expectedBytesSource: null,
    expectedBytesMismatch: false,
    downloadedBytes: 0,
    attempts: 0,
    status: 'downloading',
    startedAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    completedAt: null,
    error: null,
    lastOperation: 'transfer',
    operationFailed: false,
    qbCategory: 'jack-abc12345',
    qbSourceServer: 'My Radarr',
    sourceServerId: 'abc12345',
    importMode: null,
    importTarget: null,
    manualImportCommandId: null,
    ...overrides,
  }
}

describe('toQbTorrent', () => {
  test('downloading: progress, eta, amount_left from bytes', () => {
    const record = baseRecord({ status: 'downloading', downloadedBytes: 4, expectedBytes: 10 })
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.state).toBe('downloading')
    expect(torrent.progress).toBe(0.4)
    expect(torrent.eta).toBe(8_640_000)
    expect(torrent.amount_left).toBe(6)
  })

  test('import_queued: finished torrent uses pausedUP, full progress, content_path != save_path', () => {
    const record = baseRecord({ status: 'import_queued', downloadedBytes: 10 })
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.state).toBe('pausedUP')
    expect(torrent.progress).toBe(1)
    expect(torrent.amount_left).toBe(0)
    expect(torrent.eta).toBe(0)
    expect(torrent.content_path).toBe(record.destPath)
    expect(torrent.content_path).not.toBe(torrent.save_path)
  })

  test('hash is the stub infohash derived from release title + size', () => {
    const record = baseRecord()
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.hash).toBe(deriveHash('Big Buck Bunny', 10))
  })

  test('failed maps to error state', () => {
    const record = baseRecord({ status: 'failed' })
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.state).toBe('error')
    // A failure stays an error whatever the live state says.
    expect(toQbTorrent(record, { completedPath: '/tmp/completed', category: 'x', live: { phase: 'retry_wait', downloadsPaused: true } }).state).toBe('error')
  })

  // Radarr/Sonarr show pausedDL as Paused, and neither import nor blocklist it;
  // error would read "qBittorrent is reporting an error".
  test('a download the user cancelled in jack is paused, not an error', () => {
    const cancelled = baseRecord({ status: 'failed', lastOperation: 'transfer', operationFailed: true, error: DOWNLOAD_CANCELLED_MESSAGE, downloadedBytes: 4, expectedBytes: 10 })
    expect(toQbTorrent(cancelled, { completedPath: '/tmp/completed', category: 'jack-abc12345' })).toMatchObject({ state: 'pausedDL', progress: 0.4, amount_left: 6, dlspeed: 0, eta: 8_640_000 })
  })

  test('a real failure stays an error, also when its text resembles a cancel', () => {
    const opts = { completedPath: '/tmp/completed', category: 'jack-abc12345' }
    const failure = (overrides: Partial<DownloadRecord>) => toQbTorrent(baseRecord({ status: 'failed', lastOperation: 'transfer', operationFailed: true, ...overrides }), opts).state
    expect(failure({ error: 'The socket connection was closed unexpectedly' })).toBe('error')
    expect(failure({ error: `${DOWNLOAD_CANCELLED_MESSAGE}.` })).toBe('error')
    // A failed import with that text is not a cancel of the transfer.
    expect(failure({ lastOperation: 'import', error: DOWNLOAD_CANCELLED_MESSAGE })).toBe('error')
  })
})

describe('toQbTorrent with the live state', () => {
  const opts = (live: Parameters<typeof toQbTorrent>[1]['live']) => ({ completedPath: '/tmp/completed', category: 'jack-abc12345', live })
  const record = baseRecord({ status: 'downloading', downloadedBytes: 4, expectedBytes: 10 })

  test('a moving download reports its speed and time left', () => {
    const torrent = toQbTorrent(record, opts({ phase: 'transferring', bytesPerSecond: 2_000_000, etaSeconds: 3 }))
    expect(torrent).toMatchObject({ state: 'downloading', dlspeed: 2_000_000, eta: 3 })
  })

  test('without a known time left the eta stays unknown', () => {
    expect(toQbTorrent(record, opts({ phase: 'transferring', bytesPerSecond: 0, etaSeconds: null }))).toMatchObject({ state: 'downloading', dlspeed: 0, eta: 8_640_000 })
  })

  test('waiting for a slot or to retry is queued, never stalled', () => {
    expect(toQbTorrent(record, opts({ phase: 'queued' }))).toMatchObject({ state: 'queuedDL', dlspeed: 0, eta: 8_640_000 })
    expect(toQbTorrent(record, opts({ phase: 'retry_wait' })).state).toBe('queuedDL')
  })

  test('waiting rows are paused while downloads are paused; a running transfer keeps going', () => {
    expect(toQbTorrent(record, opts({ phase: 'queued', downloadsPaused: true })).state).toBe('pausedDL')
    expect(toQbTorrent(record, opts({ phase: 'retry_wait', downloadsPaused: true })).state).toBe('pausedDL')
    expect(toQbTorrent(record, opts({ phase: 'transferring', downloadsPaused: true, bytesPerSecond: 5 }))).toMatchObject({ state: 'downloading', dlspeed: 5 })
  })

  test('a row this process runs nothing for stays downloading', () => {
    expect(toQbTorrent(record, opts({ phase: null, downloadsPaused: true })).state).toBe('downloading')
  })

  test('a finished download ignores speed', () => {
    const done = baseRecord({ status: 'import_queued', downloadedBytes: 10 })
    expect(toQbTorrent(done, opts({ bytesPerSecond: 99, etaSeconds: 5 }))).toMatchObject({ state: 'pausedUP', dlspeed: 0, eta: 0 })
  })
})
