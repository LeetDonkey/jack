/** What the dashboard's attention card lists, by how much each row asks of the user. */
export interface AttentionCounts {
  // Something is broken: a friend or a Radarr/Sonarr jack can't reach, a failed
  // registration, failed downloads.
  errors: number
  // Something to look at that isn't failing: stuck imports, size mismatches,
  // downloads on with nothing to receive them.
  warnings: number
  // Nothing to do: Radarr/Sonarr skip jack's indexer for now and resume it by
  // themselves.
  notices: number
}

export interface AttentionHeading {
  title: string
  badge: string
  color: 'error' | 'warning'
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The heading and badge of the attention card, or null when it lists nothing.
 * Red only for something broken. When all it lists resolves by itself, it doesn't
 * say "Needs attention" or count issues, since the rows say nothing needs doing.
 */
export function attentionHeading(counts: AttentionCounts): AttentionHeading | null {
  const total = counts.errors + counts.warnings + counts.notices
  if (total === 0)
    return null
  if (counts.errors + counts.warnings === 0)
    return { title: 'Worth knowing', badge: plural(total, 'notice'), color: 'warning' }
  return { title: 'Needs attention', badge: plural(total, 'issue'), color: counts.errors > 0 ? 'error' : 'warning' }
}
