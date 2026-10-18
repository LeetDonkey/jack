export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes))
    return '—'
  if (bytes === 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null)
    return '—'
  return `${Math.round(fraction * 100)}%`
}

// Short, compact "time since" for at-a-glance dashboard rows (e.g. "14m", "2h",
// "3d"). Not meant to be precise — pairs with a full timestamp in a `title`.
export function formatAgo(iso: string | null | undefined): string {
  if (!iso)
    return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then))
    return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// Reads a millisecond config value back in human terms ("1800000" → "30 min").
// Settings surfaces the raw ms — that's what the config file holds — and pairs it
// with this so the number means something at a glance.
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms))
    return ''
  if (ms === 0)
    return 'no delay'
  // Round first, then drop a trailing ".0" — otherwise 59_999 ms reads "60.0 s".
  const trim = (n: number) => {
    const rounded = Math.round(n * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  if (ms < 1000)
    return `${ms} ms`
  if (ms < 60_000)
    return `${trim(ms / 1000)} s`
  if (ms < 3_600_000)
    return `${trim(ms / 60_000)} min`
  return `${trim(ms / 3_600_000)} h`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso)
    return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return iso
  return date.toLocaleString()
}

// Transfer speed from bytes/second, in the same 1024-based units as formatBytes.
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || Number.isNaN(bytesPerSecond))
    return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

// Time left on a transfer, coarse enough to stay readable while it ticks:
// "45s", "12m 30s", "2h 05m". Unknown (no size or no speed yet) reads "—".
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0)
    return '—'
  const s = Math.round(seconds)
  if (s < 60)
    return `${s}s`
  const minutes = Math.floor(s / 60)
  if (minutes < 60)
    return `${minutes}m ${String(s % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

// Clock times and days in the browser's time zone. 24-hour, like the times in
// jack's own messages ("Waiting to retry at 14:32").
const clockFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const dayYearFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dayLabel(date: Date, now: Date): string {
  return (date.getFullYear() === now.getFullYear() ? dayFormat : dayYearFormat).format(date)
}

/** "14:32". Empty when there is no valid time. */
export function formatClockTime(iso: string | null | undefined): string {
  if (!iso)
    return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : clockFormat.format(date)
}

/** "14:02" for a time today, otherwise the day: "17 Oct", or "17 Oct 2025" in another year. */
export function formatClockOrDay(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso)
    return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return ''
  const today = new Date(now)
  return sameDay(date, today) ? clockFormat.format(date) : dayLabel(date, today)
}

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A calendar day sent as YYYY-MM-DD: "3 Oct", or "3 Oct 2025" in another year. */
export function formatCalendarDay(day: string | null | undefined, now: number = Date.now()): string {
  const match = day ? CALENDAR_DAY.exec(day) : null
  if (!match)
    return ''
  // A local date, so the day doesn't shift with the time zone.
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return dayLabel(date, new Date(now))
}

export type FriendStatusTone = 'success' | 'neutral' | 'warning' | 'error'

/** The part of a friend's health check the status words come from. */
export interface FriendHealthInput {
  online: boolean | null
  offlineSince: string | null
  lastErrorCode: string | null
}

/**
 * A friend's status in the words every page uses: "Online", "Checking…",
 * "Offline since 14:02", "Rejected your key", "Is blocking you" or
 * "Needs a newer jack".
 */
export function friendStatusWords(health: FriendHealthInput, now: number = Date.now()): { label: string, tone: FriendStatusTone } {
  if (health.online === true)
    return { label: 'Online', tone: 'success' }
  if (health.online === null)
    return { label: 'Checking…', tone: 'neutral' }
  if (health.lastErrorCode === 'unauthorized')
    return { label: 'Rejected your key', tone: 'error' }
  if (health.lastErrorCode === 'forbidden')
    return { label: 'Is blocking you', tone: 'error' }
  if (health.lastErrorCode === 'incompatible')
    return { label: 'Needs a newer jack', tone: 'warning' }
  const since = formatClockOrDay(health.offlineSince, now)
  return { label: since ? `Offline since ${since}` : 'Offline', tone: 'error' }
}
