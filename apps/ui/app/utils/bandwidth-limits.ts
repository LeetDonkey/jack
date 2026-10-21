// Speed limits on Settings -> Bandwidth. The config file holds KiB/s; the form
// edits MB/s (MiB/s, matching the rest of the UI's 1024-based units). Empty means
// unlimited, or in a schedule period, the limit above.

/**
 * A stored limit in MB/s, to 3 decimals: what the number input shows and keeps
 * (Intl's default), and enough that the lowest limit jack stores, 1 KiB/s, shows
 * as 0.001 and not as 0.
 */
export const mbFromKib = (kib: number | null | undefined): number | null => (kib == null ? null : Math.round((kib / 1024) * 1000) / 1000)

/** Empty stays empty. Any number is kept as a limit, at least 1 KiB/s; limitError() refuses 0 first. */
export const kibFromMb = (mb: number | null | undefined): number | null => (mb == null ? null : Math.max(1, Math.round(mb * 1024)))

/**
 * The KiB/s to save for a limit field that was loaded as `stored`. While the
 * field still shows the stored limit, that limit is saved as it is: the MB/s
 * shown is rounded, and converting it back could move a limit the user didn't
 * touch (64 KiB/s shows as 0.063, which is 65 KiB/s).
 */
export function kibToSave(mb: number | null | undefined, stored: number | null | undefined): number | null {
  if (mb != null && stored != null && mbFromKib(stored) === mb)
    return stored
  return kibFromMb(mb)
}

/**
 * Why a typed limit can't be saved, or null. jack can't store 0, and leaving the
 * field empty means the opposite (no limit), so 0 and below are refused with the
 * way to get what the user likely meant.
 */
export function limitError(mb: number | null | undefined, direction: 'download' | 'upload', inPeriod = false): string | null {
  if (mb == null || mb > 0)
    return null
  const empty = inPeriod ? 'Empty uses the limit above.' : 'Empty means no limit.'
  const pause = direction === 'upload' ? 'To stop uploads, use Pause sharing.' : 'To stop downloads, use Pause downloads.'
  return `Must be more than 0. ${empty} ${pause}`
}

// The form's name for each field of the PATCH body. Limits are edited in MB/s.
const FORM_FIELDS: Record<string, string> = {
  downloadLimitKiBps: 'downloadMb',
  uploadLimitKiBps: 'uploadMb',
  maxConcurrentUploads: 'maxConcurrentUploads',
  maxConcurrentUploadsPerPeer: 'maxConcurrentUploadsPerPeer',
  dailyUploadLimitGiBPerPeer: 'dailyUploadLimitGiBPerPeer',
}

// The same within a schedule period, whose start and end share one field.
const PERIOD_FIELDS: Record<string, string> = {
  days: 'days',
  start: 'time',
  end: 'time',
  downloadLimitKiBps: 'downloadMb',
  uploadLimitKiBps: 'uploadMb',
}

const PERIOD_FIELD = /^schedule\.(\d+)\.(\w+)/

/**
 * The form field for a field jack names in a refused save (`schedule.0.end`), so
 * the message shows there. Null when the form has no field for it.
 */
export function bandwidthFormField(field: string): string | null {
  const period = PERIOD_FIELD.exec(field)
  if (period) {
    const name = PERIOD_FIELDS[period[2]!]
    return name ? `schedule.${period[1]}.${name}` : null
  }
  return FORM_FIELDS[field] ?? null
}
