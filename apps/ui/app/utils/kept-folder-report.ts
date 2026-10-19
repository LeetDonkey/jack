import type { FolderReport } from '~/types/tools'
import { folderSummary } from './folder-check'

/**
 * Which stored folder report comes back after a reload: only one that found a
 * problem, which the dashboard shows with how long ago it ran. A report that found
 * nothing wrong can go out of date without anyone noticing, so it isn't brought
 * back, and Settings only shows checks run since the page loaded.
 */
export function keptFolderReport(stored: FolderReport | null): FolderReport | null {
  return stored && folderSummary(stored).tone === 'error' ? stored : null
}
