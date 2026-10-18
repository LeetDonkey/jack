import type { RestartReason } from '~/types/management'

/** The Unraid steps for restarting jack. Render it with `whitespace-nowrap`, so "->" never breaks. */
export const RESTART_STEPS = 'Docker tab -> jack -> Restart'

// Each setting jack reads only at startup, named as Settings names it. The keys
// have no field in Settings any more, so their labels say where they live.
const RESTART_REASON_LABELS: Record<RestartReason, string> = {
  'downloads': 'Downloads',
  'downloads.completedPath': 'Completed folder',
  // jack reports the retry and the import-watcher keys as one reason.
  'downloads.retries': 'Download retries and Handing files to Radarr/Sonarr',
  'jack.tmdbApiKey': 'TMDB key (config file)',
  'jack.apiKey': 'Main API key (config file)',
}

/**
 * The settings waiting for a restart of the jack container, in the order jack lists
 * them. A reason this UI doesn't know yet (a newer jack) shows as jack names it.
 */
export function restartReasonLabels(reasons: readonly string[]): string[] {
  return reasons.map(reason => RESTART_REASON_LABELS[reason as RestartReason] ?? reason)
}
