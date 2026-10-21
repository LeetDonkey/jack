import { DownloadsConfig } from '../../lib/config'

/**
 * Settings jack reads only at startup, named for the restart banner:
 * - `downloads`: the downloads block was added (or removed). The qBittorrent API
 *   and the download queue only start with it.
 * - `downloads.completedPath`: the completed folder.
 * - `downloads.retries`: the retry and timeout knobs.
 * - `downloads.import`: the import watcher's knobs.
 * - `jack.tmdbApiKey`, `jack.apiKey`: the keys.
 */
export const RESTART_REASONS = ['downloads', 'downloads.completedPath', 'downloads.retries', 'downloads.import', 'jack.tmdbApiKey', 'jack.apiKey'] as const
export type RestartReason = typeof RESTART_REASONS[number]

// Downloads keys that apply without a restart.
export const LIVE_DOWNLOAD_KEYS: ReadonlySet<string> = new Set(['unlinkImportedFiles', 'maxConcurrentDownloads', 'pausedUntil'])

// The import watcher's downloads keys (`downloads.import`). Every other key read at
// startup, apart from completedPath, is a retry or timeout knob (`downloads.retries`).
export const IMPORT_DOWNLOAD_KEYS: ReadonlySet<string> = new Set(['importPollIntervalMs', 'maxManualImportAttempts', 'manualImportBackoffBaseMs', 'manualImportBackoffMaxMs'])

interface RawConfigLike {
  jack?: { apiKey?: unknown, tmdbApiKey?: unknown } | null
  downloads?: Record<string, unknown> | null
}

/** JSON with object keys sorted, so key order never reads as a change. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// Defaults applied, so writing a default value explicitly is not a change.
function effectiveDownloads(block: Record<string, unknown>): Record<string, unknown> {
  const parsed = DownloadsConfig.safeParse(block)
  return parsed.success ? parsed.data : block
}

/**
 * What changed since boot in settings jack reads only at startup. Both configs are
 * raw (`{env}`/`{file}` references unresolved), so a reference that still names the
 * same variable is unchanged even when its value can't be resolved here.
 */
export function pendingRestart(boot: RawConfigLike, current: RawConfigLike): RestartReason[] {
  const reasons: RestartReason[] = []

  const bootDownloads = boot.downloads ?? null
  const currentDownloads = current.downloads ?? null
  if (Boolean(bootDownloads) !== Boolean(currentDownloads)) {
    reasons.push('downloads')
  }
  else if (bootDownloads && currentDownloads) {
    const before = effectiveDownloads(bootDownloads)
    const after = effectiveDownloads(currentDownloads)
    if (stableStringify(before.completedPath) !== stableStringify(after.completedPath))
      reasons.push('downloads.completedPath')
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    const changed = [...keys].filter(key => key !== 'completedPath'
      && !LIVE_DOWNLOAD_KEYS.has(key)
      && stableStringify(before[key]) !== stableStringify(after[key]))
    if (changed.some(key => !IMPORT_DOWNLOAD_KEYS.has(key)))
      reasons.push('downloads.retries')
    if (changed.some(key => IMPORT_DOWNLOAD_KEYS.has(key)))
      reasons.push('downloads.import')
  }

  if (stableStringify(boot.jack?.tmdbApiKey) !== stableStringify(current.jack?.tmdbApiKey))
    reasons.push('jack.tmdbApiKey')
  if (stableStringify(boot.jack?.apiKey) !== stableStringify(current.jack?.apiKey))
    reasons.push('jack.apiKey')

  return reasons
}
