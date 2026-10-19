import type { FolderReport } from '~/types/tools'
import { readStoredFolderReport, storeFolderReport } from '~/utils/folder-report-storage'
import { keptFolderReport } from '~/utils/kept-folder-report'

// A run asked for while one is on its way (Check folders, then a save) starts
// again once that one ends, so the report always reflects the latest settings.
let again = false

// localStorage, or undefined where there is none.
function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  }
  catch {
    return undefined
  }
}

/**
 * The folder check (POST /diagnostics/folders): can jack see each shared library
 * where Radarr/Sonarr keep it, and does each Radarr/Sonarr that receives
 * downloads see jack's completed folder at the same path. Shared, so the
 * Downloads section, the Radarr/Sonarr cards and the dashboard show the same
 * report. Nothing runs it on page load.
 *
 * `report` is the last check since the page loaded. `lastReport` also brings back
 * a problem an earlier check found, kept in this browser, so the dashboard still
 * shows it after a reload, with how long ago it ran (see keptFolderReport).
 */
export function useFolderCheck() {
  const { request, extractError } = useManagement()
  const report = useState<FolderReport | null>('folder-check:report', () => null)
  const kept = useState<FolderReport | null>('folder-check:kept', () => keptFolderReport(readStoredFolderReport(browserStorage())))
  const lastReport = computed(() => report.value ?? kept.value)
  const running = useState('folder-check:running', () => false)
  const error = useState<string | null>('folder-check:error', () => null)

  async function run(): Promise<void> {
    if (running.value) {
      again = true
      return
    }
    running.value = true
    error.value = null
    try {
      do {
        again = false
        report.value = await request<FolderReport>('diagnostics/folders', { method: 'POST' })
        storeFolderReport(browserStorage(), report.value)
      } while (again)
    }
    catch (err) {
      error.value = extractError(err, 'Could not check the folders.')
    }
    finally {
      running.value = false
      again = false
    }
  }

  return { report, lastReport, running, error, run }
}
