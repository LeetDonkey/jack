import type { DownloadRecord } from '../downloads/downloads.repository'
import type { TrafficTotal } from '../transfers/traffic-ledger'
import type { Notification } from './notifications.service'
import { localDay } from '../transfers/traffic-ledger'

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/** Today's traffic per friend and what happened to downloads, as one notification. */
export function buildDailySummary(totals: TrafficTotal[], downloads: DownloadRecord[], now: Date): Notification {
  const today = localDay(now)
  const on = (iso: string | null) => iso != null && localDay(new Date(iso)) === today
  const finished = downloads.filter(d => on(d.completedAt)).length
  const failed = downloads.filter(d => d.status === 'failed' && on(d.updatedAt)).length
  const running = downloads.filter(d => d.status === 'downloading').length

  const lines = [
    ...totals.filter(t => t.direction === 'in').map(t => `Downloaded ${gb(t.bytes)} from ${t.label}`),
    ...totals.filter(t => t.direction === 'out').map(t => `Uploaded ${gb(t.bytes)} to ${t.label}`),
  ]
  if (lines.length === 0)
    lines.push('No traffic with friends today')
  lines.push(`Downloads: ${finished} finished, ${failed} failed, ${running} still running`)
  return { event: 'daily-summary', title: `jack today (${today})`, message: lines.join('\n') }
}
