import type { BandwidthConfig, BandwidthPeriod } from '../config'

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export interface ActiveBandwidthLimits {
  /** Bytes per second, or null for unlimited. */
  downloadBytesPerSecond: number | null
  uploadBytesPerSecond: number | null
  /** Index into `schedule` of the period in force, or null outside every period. */
  periodIndex: number | null
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours! * 60 + minutes!
}

function kibToBytes(kib: number | null | undefined): number | null {
  return kib != null && kib > 0 ? kib * 1024 : null
}

/**
 * Whether `period` covers `date` in local time. `start` is inclusive and `end`
 * exclusive. A period whose end is at or before its start runs past midnight and
 * belongs to the day it starts on: `fri 23:00-07:00` covers Friday 23:00 to
 * Saturday 07:00. `start === end` covers the whole day.
 */
export function periodCovers(period: BandwidthPeriod, date: Date): boolean {
  const day = WEEKDAYS[date.getDay()]!
  const previousDay = WEEKDAYS[(date.getDay() + 6) % 7]!
  const minute = date.getHours() * 60 + date.getMinutes()
  const start = minutesOf(period.start)
  const end = minutesOf(period.end)

  if (start === end)
    return period.days.includes(day)
  if (start < end)
    return period.days.includes(day) && minute >= start && minute < end
  return (period.days.includes(day) && minute >= start)
    || (period.days.includes(previousDay) && minute < end)
}

/**
 * Resolve the limits in force at `date`. The first period that covers it wins; a
 * limit the period leaves unset falls back to the block-level default. Outside
 * every period the defaults apply.
 */
export function resolveBandwidthLimits(config: BandwidthConfig | undefined, date: Date): ActiveBandwidthLimits {
  const schedule = config?.schedule ?? []
  const periodIndex = schedule.findIndex(period => periodCovers(period, date))
  const period = periodIndex >= 0 ? schedule[periodIndex] : undefined
  return {
    downloadBytesPerSecond: kibToBytes(period?.downloadLimitKiBps ?? config?.downloadLimitKiBps),
    uploadBytesPerSecond: kibToBytes(period?.uploadLimitKiBps ?? config?.uploadLimitKiBps),
    periodIndex: period ? periodIndex : null,
  }
}
