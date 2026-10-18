import type { FolderReport } from '~/types/tools'

// A run asked for while one is on its way (Check folders, then a save) starts
// again once that one ends, so the report always reflects the latest settings.
let again = false

/**
 * The folder check (POST /diagnostics/folders): can jack see each shared library
 * where Radarr/Sonarr keep it, and does each Radarr/Sonarr that receives
 * downloads see jack's completed folder at the same path. Shared, so the
 * Downloads section and the Radarr/Sonarr cards show the same report. Nothing
 * runs it on page load; the report lasts until the page is reloaded.
 */
export function useFolderCheck() {
  const { request, extractError } = useManagement()
  const report = useState<FolderReport | null>('folder-check:report', () => null)
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

  return { report, running, error, run }
}
