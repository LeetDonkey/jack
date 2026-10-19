import type { CheckStatus, FolderReport } from '~/types/tools'
import { describe, expect, test } from 'bun:test'
import { keptFolderReport } from './kept-folder-report'

// A check from Monday morning: Radarr sees jack's completed folder, or doesn't.
function report(status: CheckStatus): FolderReport {
  return {
    checkedAt: '2026-10-12T05:28:00.000Z',
    ok: status === 'ok',
    sources: [],
    completed: {
      path: '/data/jack',
      status,
      message: 'jack can write to the completed folder.',
      exists: true,
      writable: true,
      freeBytes: 1024,
      destinations: [{
        serverId: 'radarr',
        name: 'Radarr',
        type: 'radarr',
        status,
        message: status === 'ok' ? 'Radarr sees jack\'s completed folder at /data/jack.' : 'Radarr doesn\'t see jack\'s completed folder at /data/jack.',
      }],
    },
  }
}

describe('keptFolderReport', () => {
  test('brings back a report that found a problem', () => {
    const failed = report('error')
    expect(keptFolderReport(failed)).toBe(failed)
  })

  test('drops an all-clear from an earlier visit, which may be out of date', () => {
    expect(keptFolderReport(report('ok'))).toBeNull()
  })

  test('drops a report whose checks only couldn\'t run', () => {
    expect(keptFolderReport(report('unknown'))).toBeNull()
  })

  test('nothing stored stays nothing', () => {
    expect(keptFolderReport(null)).toBeNull()
  })
})
