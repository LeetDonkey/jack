import { describe, expect, test } from 'bun:test'
import {
  dashboardDownloadCounts,
  downloadActionsFor,
  downloadState,
  isCancelledDownload,
  matchesDownloadFilter,
  parseDownloadFilter,
  retryableFailures,
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
    const state = downloadState(running({ phase: 'retry_wait', retryAt, attempts: 3, error: 'Waiting to retry at 12:32: connect ECONNREFUSED' }))
    expect(state).toEqual({ label: 'Retrying at 14:32', color: 'warning', note: 'Attempt 3 failed: connect ECONNREFUSED', noteTone: 'muted' })
  })

  test('reads a retry wait from jack\'s message when the row has no phase', () => {
    const state = downloadState(running({ phase: null, attempts: 2, error: 'Waiting to retry at 09:05: timed out' }))
    expect(state).toMatchObject({ label: 'Retrying at 09:05', color: 'warning', note: 'Attempt 2 failed: timed out' })
  })

  test('shows a cancel as neutral and a failure as an error', () => {
    expect(downloadState(item({ error: 'Download cancelled by user', cancelledByUser: true }))).toMatchObject({ label: 'Cancelled', color: 'neutral', noteTone: 'muted' })
    expect(downloadState(item())).toEqual({ label: 'Failed', color: 'error', note: 'boom', noteTone: 'error' })
  })

  test('labels the finished states', () => {
    expect(downloadState(item({ status: 'import_queued', error: null })).label).toBe('Import queued')
    expect(downloadState(item({ status: 'imported', error: null })).label).toBe('Imported')
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

  test('reads the filter from the address bar', () => {
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
