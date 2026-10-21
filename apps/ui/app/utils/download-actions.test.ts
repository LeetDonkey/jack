import { describe, expect, test } from 'bun:test'
import {
  canRetryNow,
  dashboardDownloadCounts,
  downloadActionsFor,
  downloadErrorDetail,
  downloadsEmptyState,
  downloadState,
  isCancelledDownload,
  matchesDownloadFilter,
  parseDownloadFilter,
  plainDownloadError,
  retryableFailures,
  retryNowFailure,
  sortRunningDownloads,
} from './download-actions'

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    filename: 'movie.mkv',
    peerName: 'Peer',
    peerId: 'peer-1',
    status: 'failed',
    downloadedBytes: 5,
    totalBytes: 10,
    progress: 0.5,
    releaseSize: 10,
    attempts: 1,
    error: 'boom',
    lastOperation: 'transfer',
    operationFailed: true,
    startedAt: '',
    updatedAt: '',
    completedAt: null,
    expectedBytesMismatch: false,
    phase: null,
    retryAt: null,
    cancelledByUser: false,
    ...overrides,
  } as any
}

function running(overrides: Record<string, unknown> = {}) {
  return item({ status: 'downloading', operationFailed: false, error: null, phase: 'transferring', ...overrides })
}

describe('downloadActionsFor', () => {
  test('offers cancel and delete for an active transfer', () => {
    expect(downloadActionsFor(item({ status: 'downloading', operationFailed: false }))).toEqual(['cancel', 'delete'])
  })

  test('offers retry for transfer failures and supported manual import failures', () => {
    expect(downloadActionsFor(item())).toEqual(['retry', 'delete'])
    expect(downloadActionsFor(item({ lastOperation: 'import', importMode: 'jack_manual', importTarget: { kind: 'movie', movieId: 42 } }))).toEqual(['retry', 'delete'])
  })

  test('does not offer retry for an import failure the backend cannot re-trigger', () => {
    expect(downloadActionsFor(item({ lastOperation: 'import', importMode: null, importTarget: null }))).toEqual(['delete'])
    expect(downloadActionsFor(item({ lastOperation: 'import', importMode: 'jack_manual', importTarget: null }))).toEqual(['delete'])
  })

  test('offers only delete when there is no failed operation', () => {
    expect(downloadActionsFor(item({ status: 'failed', operationFailed: false }))).toEqual(['delete'])
  })

  test('keeps Retry on a download the user cancelled', () => {
    expect(downloadActionsFor(item({ error: 'Download cancelled by user', cancelledByUser: true }))).toEqual(['retry', 'delete'])
  })
})

describe('downloadState', () => {
  test('tells a transferring download from one waiting for a slot', () => {
    expect(downloadState(running())).toMatchObject({ label: 'Downloading', color: 'primary', note: null })
    expect(downloadState(running({ phase: 'queued' }))).toMatchObject({ label: 'Waiting for a free slot', color: 'neutral' })
    expect(downloadState(running({ phase: 'queued' }), { downloadsPaused: true })).toMatchObject({ label: 'Paused', color: 'neutral' })
  })

  test('shows a retry wait as a warning with the reason as a muted note', () => {
    const retryAt = new Date(2026, 9, 18, 14, 32).toISOString()
    const state = downloadState(running({ phase: 'retry_wait', retryAt, attempts: 3, error: 'Waiting to retry at 12:32: something odd' }))
    expect(state).toEqual({ label: 'Retrying at 14:32', color: 'warning', note: 'Attempt 3 failed: something odd', noteTone: 'muted', detail: null })
  })

  test('puts a known retry reason in plain words, with jack\'s text as the detail', () => {
    const state = downloadState(running({ phase: 'retry_wait', attempts: 3, error: 'Waiting to retry at 12:32: connect ECONNREFUSED' }))
    expect(state).toMatchObject({ note: 'Attempt 3 failed. Can\'t reach Peer\'s jack.', detail: 'connect ECONNREFUSED' })
  })

  test('reads a retry wait from jack\'s message when the row has no phase', () => {
    const state = downloadState(running({ phase: null, attempts: 2, error: 'Waiting to retry at 09:05: weird' }))
    expect(state).toMatchObject({ label: 'Retrying at 09:05', color: 'warning', note: 'Attempt 2 failed: weird' })
  })

  test('a retry wait while downloads are paused says so instead of promising a time', () => {
    const retryAt = new Date(2026, 9, 18, 14, 32).toISOString()
    const waiting = running({ phase: 'retry_wait', retryAt, attempts: 1, error: 'Waiting to retry at 14:32: something odd' })
    expect(downloadState(waiting, { downloadsPaused: true })).toEqual({
      label: 'Paused',
      color: 'neutral',
      note: 'Downloads are paused. This one retries after you resume them. Attempt 1 failed: something odd.',
      noteTone: 'muted',
      detail: null,
    })
    const missing = running({ phase: 'retry_wait', retryAt, attempts: 2, error: 'Waiting to retry at 14:32: Bob can\'t find this file on disk right now (404). It may be moving or upgrading it, or a mount is missing there.' })
    expect(downloadState(missing, { downloadsPaused: true }).note)
      .toBe('Downloads are paused. This one retries after you resume them. Attempt 2 failed. Peer can\'t find this file right now. Their Radarr/Sonarr may be moving or upgrading it, or a folder is missing in their jack.')
    expect(downloadState(running({ phase: 'retry_wait', error: null }), { downloadsPaused: true }).note)
      .toBe('Downloads are paused. This one retries after you resume them.')
    const busy = running({ phase: 'retry_wait', retryAt, attempts: 1, peerName: 'Bob', error: 'Waiting to retry at 14:32: Failed to download file from peer: Service Unavailable' })
    expect(downloadState(busy, { downloadsPaused: true })).toMatchObject({
      note: 'Downloads are paused. This one retries after you resume them. Attempt 1 failed. Bob\'s jack is busy or has paused sharing.',
      detail: 'Failed to download file from peer: Service Unavailable',
    })
  })

  test('shows a cancel as neutral and a failure as an error', () => {
    expect(downloadState(item({ error: 'Download cancelled by user', cancelledByUser: true }))).toMatchObject({ label: 'Cancelled', color: 'neutral', noteTone: 'muted' })
    expect(downloadState(item())).toEqual({ label: 'Failed', color: 'error', note: 'boom', noteTone: 'error', detail: null })
  })

  test('a known failure reads in plain words and keeps jack\'s text as the detail', () => {
    const raw = 'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'
    expect(downloadState(item({ error: raw }))).toEqual({ label: 'Failed', color: 'error', note: 'The connection to Peer dropped.', noteTone: 'error', detail: 'The socket connection was closed unexpectedly.' })
  })

  test('jack\'s own sentence about a missing file shows once, in the plain words', () => {
    const raw = 'Waiting to retry at 14:32: Bob can\'t find this file on disk right now (404). It may be moving or upgrading it, or a mount is missing there.'
    const state = downloadState(running({ phase: 'retry_wait', attempts: 2, peerName: 'Bob', error: raw }))
    expect(state.note).toBe('Attempt 2 failed. Bob can\'t find this file right now. Their Radarr/Sonarr may be moving or upgrading it, or a folder is missing in their jack.')
    expect(state.detail).toBeNull()
  })

  test('labels the finished states', () => {
    expect(downloadState(item({ status: 'import_queued', error: null })).label).toBe('Import queued')
    expect(downloadState(item({ status: 'imported', error: null })).label).toBe('Imported')
  })
})

describe('plainDownloadError', () => {
  const failure = (error: string, overrides: Record<string, unknown> = {}) => plainDownloadError(item({ error, peerName: 'Bob', ...overrides }))

  test('puts the failures jack knows in plain words', () => {
    expect(failure('The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'))
      .toBe('The connection to Bob dropped.')
    expect(failure('read ECONNRESET')).toBe('The connection to Bob dropped.')
    expect(failure('Peer download stalled: no data received for 60000ms')).toBe('No data came from Bob for a while.')
    expect(failure('The operation timed out.')).toBe('Bob\'s jack took too long to answer.')
    expect(failure('Bob can\'t find this file on disk right now (404). It may be moving or upgrading it, or a mount is missing there.'))
      .toBe('Bob can\'t find this file right now. Their Radarr/Sonarr may be moving or upgrading it, or a folder is missing in their jack.')
    expect(failure('Failed to download file from peer: Not Found')).toMatch(/^Bob can't find this file right now\./)
    expect(failure('ENOSPC: no space left on device, write')).toBe('The disk where jack saves downloads is full. Free up space, then retry.')
    expect(failure('The value of "length" is out of range. It must be >= 0 && <= 2147483647. Received 3027353600'))
      .toBe('jack ran into an internal error with this file. Retry continues from the partial file.')
    expect(failure('Unable to connect. Is the computer able to access the url?')).toBe('Can\'t reach Bob\'s jack.')
    expect(failure('Was there a typo in the url or port?')).toBe('Can\'t reach Bob\'s jack.')
  })

  test('a friend\'s jack that is busy, has paused sharing or used up today\'s limit', () => {
    const busy = 'Bob\'s jack is busy or has paused sharing.'
    expect(failure('Failed to download file from peer: Service Unavailable')).toBe(busy)
    expect(failure('Failed to resume download from peer: Service Unavailable')).toBe(busy)
    expect(failure('Failed to continue download from peer: Service Unavailable')).toBe(busy)
    expect(failure('Failed to fetch bytes 0-99 from peer: 503 Service Unavailable')).toBe(busy)
    const limit = 'You\'ve downloaded as much from Bob today as they allow.'
    expect(failure('Failed to download file from peer: Too Many Requests')).toBe(limit)
    expect(failure('Failed to fetch bytes 0-99 from peer: 429 Too Many Requests')).toBe(limit)
  })

  test('reads past jack\'s "Waiting to retry at" prefix', () => {
    expect(failure('Waiting to retry at 14:32: read ECONNRESET')).toBe('The connection to Bob dropped.')
  })

  test('leaves unknown text, import failures and empty errors alone', () => {
    expect(failure('Unsafe release filename from peer: ../x.mkv')).toBeNull()
    expect(failure('connect ECONNREFUSED 192.168.0.5:7878', { lastOperation: 'import' })).toBeNull()
    expect(plainDownloadError(item({ error: null }))).toBeNull()
  })
})

describe('downloadErrorDetail', () => {
  const detail = (error: string | null, overrides: Record<string, unknown> = {}) => downloadErrorDetail(item({ error, peerName: 'Bob', ...overrides }))

  test('is jack\'s text behind the plain words, without the retry prefix', () => {
    expect(detail('Waiting to retry at 14:32: Failed to download file from peer: Service Unavailable'))
      .toBe('Failed to download file from peer: Service Unavailable')
    expect(detail('Failed to download file from peer: Not Found')).toBe('Failed to download file from peer: Not Found')
    expect(detail('read ECONNRESET')).toBe('read ECONNRESET')
  })

  test('leaves off Bun\'s hint for developers', () => {
    expect(detail('Waiting to retry at 14:32: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'))
      .toBe('The socket connection was closed unexpectedly.')
  })

  test('is null where the plain words already say it, or where there are none', () => {
    expect(detail('Bob can\'t find this file on disk right now (404). It may be moving or upgrading it, or a mount is missing there.')).toBeNull()
    expect(detail('Unsafe release filename from peer: ../x.mkv')).toBeNull()
    expect(detail('connect ECONNREFUSED 192.168.0.5:7878', { lastOperation: 'import' })).toBeNull()
    expect(detail(null)).toBeNull()
  })
})

describe('canRetryNow', () => {
  test('only for a row waiting to retry, and not while downloads are paused', () => {
    const waiting = running({ phase: 'retry_wait', error: 'Waiting to retry at 14:32: busy' })
    expect(canRetryNow(waiting)).toBe(true)
    expect(canRetryNow(waiting, { downloadsPaused: true })).toBe(false)
    expect(canRetryNow(running())).toBe(false)
    expect(canRetryNow(running({ phase: 'queued' }))).toBe(false)
    expect(canRetryNow(item())).toBe(false)
  })
})

describe('retryNowFailure', () => {
  test('a row that stopped waiting or is gone is stale', () => {
    expect(retryNowFailure({ status: 409, code: 'CONFLICT' })).toBe('stale')
    expect(retryNowFailure({ status: 404, code: 'NOT_FOUND' })).toBe('stale')
  })

  test('a 404 without jack\'s error code means jack has no Retry now yet', () => {
    expect(retryNowFailure({ status: 404, code: null })).toBe('unsupported')
  })

  test('anything else is an error', () => {
    expect(retryNowFailure({ status: 503, code: null })).toBe('error')
    expect(retryNowFailure({ status: undefined, code: null })).toBe('error')
  })
})

describe('isCancelledDownload', () => {
  test('uses the flag, and jack\'s message when a row has none', () => {
    expect(isCancelledDownload(item({ cancelledByUser: true }))).toBe(true)
    expect(isCancelledDownload(item({ cancelledByUser: undefined, error: 'Download cancelled by user' }))).toBe(true)
    expect(isCancelledDownload(item({ cancelledByUser: undefined }))).toBe(false)
    expect(isCancelledDownload(running({ cancelledByUser: undefined, error: 'Download cancelled by user' }))).toBe(false)
  })
})

describe('download filters', () => {
  const rows = [
    running({ id: 1 }),
    item({ id: 2, status: 'import_queued', error: null }),
    item({ id: 3 }),
    item({ id: 4, cancelledByUser: true, error: 'Download cancelled by user' }),
    item({ id: 5, status: 'imported', error: null }),
  ]
  const ids = (filter: Parameters<typeof matchesDownloadFilter>[1]) => rows.filter(r => matchesDownloadFilter(r, filter)).map(r => r.id)

  test('Active holds what is running, waiting for import or failed, but no cancels', () => {
    expect(ids('active')).toEqual([1, 2, 3])
  })

  test('Failed leaves cancels out and Cancelled holds only them', () => {
    expect(ids('failed')).toEqual([3])
    expect(ids('cancelled')).toEqual([4])
    expect(ids('imported')).toEqual([5])
    expect(ids('all')).toEqual([1, 2, 3, 4, 5])
  })

  test('Waiting holds running downloads without a slot or waiting to retry, and Downloading the rest', () => {
    const waitingRows = [
      running({ id: 1 }),
      running({ id: 2, phase: 'queued' }),
      running({ id: 3, phase: 'retry_wait', error: 'Waiting to retry at 14:32: busy' }),
      // A jack without phases: the message tells a retry wait.
      running({ id: 4, phase: undefined, error: 'Waiting to retry at 14:32: busy' }),
      running({ id: 5, phase: undefined }),
      item({ id: 6 }),
    ]
    const of = (filter: Parameters<typeof matchesDownloadFilter>[1]) => waitingRows.filter(r => matchesDownloadFilter(r, filter)).map(r => r.id)
    expect(of('waiting')).toEqual([2, 3, 4])
    expect(of('downloading')).toEqual([1, 5])
    expect(of('active')).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('reads the filter from the address bar', () => {
    expect(parseDownloadFilter('waiting')).toBe('waiting')
    expect(parseDownloadFilter('failed')).toBe('failed')
    expect(parseDownloadFilter(['import_queued'])).toBe('import_queued')
    expect(parseDownloadFilter('nope')).toBeNull()
    expect(parseDownloadFilter(undefined)).toBeNull()
  })

  test('Retry all failed takes only failures Retry can start', () => {
    const importFailure = item({ id: 6, lastOperation: 'import', importMode: null, importTarget: null })
    expect(retryableFailures([...rows, importFailure]).map(r => r.id)).toEqual([3])
  })
})

describe('dashboardDownloadCounts', () => {
  test('splits running downloads into Downloading and Waiting', () => {
    const counts = dashboardDownloadCounts({
      byStatus: { downloading: 5, import_queued: 1, imported: 9, failed: 2 },
      byPhase: { queued: 2, transferring: 3, retry_wait: 0 },
    })
    expect(counts).toEqual({ downloading: 3, waiting: 2, importQueued: 1, failed: 2 })
  })

  test('counts a running download without a phase as downloading', () => {
    expect(dashboardDownloadCounts({ byStatus: { downloading: 2 }, byPhase: { queued: 0, transferring: 0, retry_wait: 1 } }))
      .toMatchObject({ downloading: 1, waiting: 1, failed: 0 })
  })
})

describe('sortRunningDownloads', () => {
  test('puts moving downloads first, then retries, then the queue', () => {
    const rows = [running({ id: 1, phase: 'queued' }), running({ id: 2, phase: 'retry_wait' }), running({ id: 3 }), running({ id: 4, phase: null })]
    expect(sortRunningDownloads(rows).map(r => r.id)).toEqual([3, 4, 2, 1])
  })
})

describe('downloadsEmptyState', () => {
  const indexerOk = { indexer: { status: 'ok' }, indexerTest: 'ok' } as any
  function overview({ peers = 1, servers = [{ destination: true, registration: indexerOk }] as Array<{ destination: boolean, registration: any }>, restartPending = [] as string[] } = {}) {
    return {
      peers: { total: peers },
      servers: { total: servers.length, destinations: servers.filter(s => s.destination).length, items: servers },
      system: { restartPending },
    }
  }
  const base = { downloadsConfig: { completedPath: '/data/jack' }, downloadsConfigFailed: false, overview: overview(), overviewFailed: false }

  test('downloads off, or waiting for the restart', () => {
    expect(downloadsEmptyState({ ...base, downloadsConfig: null })).toBe('off')
    expect(downloadsEmptyState({ ...base, overview: overview({ restartPending: ['downloads'] }) })).toBe('restart')
  })

  test('waits for the config and the overview instead of guessing', () => {
    expect(downloadsEmptyState({ ...base, downloadsConfig: undefined })).toBe('loading')
    expect(downloadsEmptyState({ ...base, overview: undefined })).toBe('loading')
    // A failed load doesn't keep it loading.
    expect(downloadsEmptyState({ ...base, overview: undefined, overviewFailed: true })).toBe('library')
    expect(downloadsEmptyState({ ...base, downloadsConfig: undefined, downloadsConfigFailed: true })).toBe('library-or-search')
  })

  test('names the missing Radarr/Sonarr before the missing friend', () => {
    expect(downloadsEmptyState({ ...base, overview: overview({ peers: 0, servers: [] }) })).toBe('no-server')
    expect(downloadsEmptyState({ ...base, overview: overview({ servers: [{ destination: false, registration: null }] }) })).toBe('no-receiver')
    expect(downloadsEmptyState({ ...base, overview: overview({ peers: 0 }) })).toBe('no-friend')
  })

  test('mentions the indexer only where jack added one that works', () => {
    expect(downloadsEmptyState(base)).toBe('library-or-search')
    expect(downloadsEmptyState({ ...base, overview: overview({ servers: [{ destination: true, registration: null }] }) })).toBe('library')
    expect(downloadsEmptyState({ ...base, overview: overview({ servers: [{ destination: true, registration: { indexer: { status: 'failed' }, indexerTest: 'skipped' } }] }) })).toBe('library')
    expect(downloadsEmptyState({ ...base, overview: overview({ servers: [{ destination: true, registration: { indexer: { status: 'ok' }, indexerTest: 'failed' } }] }) })).toBe('library')
  })
})
