import type { FolderReport } from '~/types/tools'
import { describe, expect, test } from 'bun:test'
import { FOLDER_REPORT_STORAGE_KEY, readStoredFolderReport, storeFolderReport } from './folder-report-storage'

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  }
}

const report: FolderReport = {
  checkedAt: '2026-10-19T05:28:00.000Z',
  ok: false,
  sources: [],
  completed: {
    path: '/data/jack',
    status: 'error',
    message: 'jack can write to the completed folder.',
    exists: true,
    writable: true,
    freeBytes: null,
    destinations: [{ serverId: 'radarr', name: 'Radarr', type: 'radarr', status: 'error', message: 'Radarr doesn\'t see jack\'s completed folder at /data/jack.' }],
  },
}

describe('folder report storage', () => {
  test('a stored report comes back as it was', () => {
    const storage = memoryStorage()
    storeFolderReport(storage, report)
    expect(readStoredFolderReport(storage)).toEqual(report)
  })

  test('nothing stored, no storage, or something else stored reads as null', () => {
    expect(readStoredFolderReport(memoryStorage())).toBeNull()
    expect(readStoredFolderReport(undefined)).toBeNull()
    expect(readStoredFolderReport(memoryStorage({ [FOLDER_REPORT_STORAGE_KEY]: '{not json' }))).toBeNull()
    expect(readStoredFolderReport(memoryStorage({ [FOLDER_REPORT_STORAGE_KEY]: JSON.stringify({ checkedAt: 'x' }) }))).toBeNull()
    expect(readStoredFolderReport(memoryStorage({ [FOLDER_REPORT_STORAGE_KEY]: JSON.stringify({ ...report, completed: { path: '/x' } }) }))).toBeNull()
  })

  test('storage that throws is ignored', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readStoredFolderReport(broken)).toBeNull()
    expect(() => storeFolderReport(broken, report)).not.toThrow()
  })
})
