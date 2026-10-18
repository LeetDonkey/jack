import type { CheckStatus, FolderReport, SourceFolderReport } from '~/types/tools'

export interface FolderProblem {
  status: CheckStatus
  message: string
}

export interface FolderSummary {
  /** `ok`: nothing wrong; `warning`: some checks couldn't run; `error`: something to fix. */
  tone: 'ok' | 'warning' | 'error'
  text: string
}

// The checks under one source that didn't pass, folders before files.
function sourceProblems(source: SourceFolderReport): FolderProblem[] {
  const checks = [...source.rootFolders, ...source.sampleFiles].filter(check => check.status !== 'ok')
  // `message` says why the source as a whole couldn't be checked.
  const whole = source.status !== 'ok' && source.message ? [{ status: source.status, message: source.message }] : []
  return [...whole, ...checks]
}

/**
 * Everything the report found wrong, in the order to fix it: the completed
 * folder (each Radarr/Sonarr's view of it says more than the folder's own
 * summary), then each shared library.
 */
export function folderProblems(report: FolderReport): FolderProblem[] {
  const problems: FolderProblem[] = []
  const completed = report.completed
  if (completed) {
    const destinations = completed.destinations.filter(d => d.status !== 'ok')
    if (destinations.length)
      problems.push(...destinations)
    else if (completed.status !== 'ok')
      problems.push({ status: completed.status, message: completed.message })
  }
  for (const source of report.sources)
    problems.push(...sourceProblems(source))
  return problems
}

/** One line for the whole report: all good, or the first problem in jack's words (they name the path). */
export function folderSummary(report: FolderReport): FolderSummary {
  if (report.sources.length === 0 && !report.completed)
    return { tone: 'warning', text: 'Nothing to check yet: no Radarr or Sonarr shares its library, and downloads are off.' }
  const problems = folderProblems(report)
  const error = problems.find(p => p.status === 'error')
  if (error)
    return { tone: 'error', text: error.message }
  const unknown = problems.find(p => p.status === 'unknown')
  if (unknown)
    return { tone: 'warning', text: `Some checks couldn't run. ${unknown.message}` }
  return { tone: 'ok', text: 'All folders line up.' }
}

/**
 * The report's result for one Radarr/Sonarr: its library (when it shares) and its
 * view of the completed folder (when it receives downloads). Null when the report
 * didn't cover that server.
 */
export function serverFolderResult(report: FolderReport, serverId: string): FolderProblem | null {
  const source = report.sources.find(s => s.serverId === serverId)
  const destination = report.completed?.destinations.find(d => d.serverId === serverId)
  if (!source && !destination)
    return null
  const problems = [
    ...(destination && destination.status !== 'ok' ? [destination] : []),
    ...(source ? sourceProblems(source) : []),
  ]
  return problems.find(p => p.status === 'error')
    ?? problems.find(p => p.status === 'unknown')
    ?? { status: 'ok', message: 'Folders line up.' }
}
