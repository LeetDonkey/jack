import type { FolderReport } from '~/types/tools'

/**
 * The last folder check, kept in this browser so a problem it found still shows
 * after a reload. Storage can be missing or throw (private windows, blocked site
 * data); the report is then simply not kept.
 */
export const FOLDER_REPORT_STORAGE_KEY = 'jack:folder-check:report'

type ReportStorage = Pick<Storage, 'getItem' | 'setItem'>

function isFolderReport(value: unknown): value is FolderReport {
  if (!value || typeof value !== 'object')
    return false
  const report = value as Partial<FolderReport>
  const completed = report.completed
  return typeof report.checkedAt === 'string'
    && Array.isArray(report.sources)
    && report.sources.every(s => s && typeof s === 'object' && Array.isArray(s.rootFolders) && Array.isArray(s.sampleFiles))
    && (completed === null || (typeof completed === 'object' && Array.isArray(completed.destinations)))
}

/** The stored report, or null when there is none or it isn't one this UI can read. */
export function readStoredFolderReport(storage: ReportStorage | undefined): FolderReport | null {
  try {
    const raw = storage?.getItem(FOLDER_REPORT_STORAGE_KEY)
    if (!raw)
      return null
    const parsed: unknown = JSON.parse(raw)
    return isFolderReport(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

export function storeFolderReport(storage: ReportStorage | undefined, report: FolderReport): void {
  try {
    storage?.setItem(FOLDER_REPORT_STORAGE_KEY, JSON.stringify(report))
  }
  catch {}
}
