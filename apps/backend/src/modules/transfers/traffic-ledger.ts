import type { Database } from 'bun:sqlite'

export type TrafficDirection = 'in' | 'out'

export interface TrafficTotal {
  direction: TrafficDirection
  party: string
  label: string
  bytes: number
}

// Fork-only table, created outside the drizzle migrations so merging upstream
// migrations never collides with it.
const CREATE_TABLE = `
  create table if not exists peer_traffic (
    day text not null,
    direction text not null check (direction in ('in', 'out')),
    party text not null,
    label text not null,
    bytes integer not null default 0,
    primary key (day, direction, party)
  )`

// Pending bytes are written at most this often.
const FLUSH_MS = 30_000

// YYYY-MM-DD in the server's time zone (the container's TZ).
const dayFormat = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' })

export function localDay(at: Date): string {
  return dayFormat.format(at)
}

/**
 * Bytes moved per peer and local day, in both directions: `in` is what we
 * downloaded from a peer (party `peer:<connector id>`), `out` what a friend
 * downloaded from us (party `key:<api key id>`). Counts are kept in memory and
 * written to the database every 30 seconds and on stop.
 */
export class TrafficLedger {
  private readonly pending = new Map<string, { day: string, direction: TrafficDirection, party: string, label: string, bytes: number }>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly sqlite: Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    sqlite.exec(CREATE_TABLE)
  }

  start(): void {
    if (this.timer)
      return
    this.timer = setInterval(() => this.flush(), FLUSH_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
    this.flush()
  }

  add(direction: TrafficDirection, party: string, label: string, bytes: number): void {
    if (bytes <= 0)
      return
    const day = localDay(this.now())
    const key = `${day}|${direction}|${party}`
    const entry = this.pending.get(key)
    if (entry) {
      entry.bytes += bytes
      entry.label = label
    }
    else {
      this.pending.set(key, { day, direction, party, label, bytes })
    }
  }

  flush(): void {
    if (this.pending.size === 0)
      return
    const upsert = this.sqlite.prepare(`
      insert into peer_traffic (day, direction, party, label, bytes) values (?, ?, ?, ?, ?)
      on conflict (day, direction, party) do update set bytes = bytes + excluded.bytes, label = excluded.label`)
    const entries = [...this.pending.values()]
    this.pending.clear()
    this.sqlite.transaction(() => {
      for (const e of entries)
        upsert.run(e.day, e.direction, e.party, e.label, e.bytes)
    })()
  }

  /** Bytes moved today (server time) for one party, including unflushed counts. */
  bytesToday(direction: TrafficDirection, party: string): number {
    const day = localDay(this.now())
    const row = this.sqlite.query<{ bytes: number }, [string, string, string]>(
      'select bytes from peer_traffic where day = ? and direction = ? and party = ?',
    ).get(day, direction, party)
    return (row?.bytes ?? 0) + (this.pending.get(`${day}|${direction}|${party}`)?.bytes ?? 0)
  }

  /**
   * Bytes moved in each direction since the table was created, unflushed counts
   * included, and the first day counted (YYYY-MM-DD; null before any traffic).
   */
  lifetime(): { in: number, out: number, since: string | null } {
    const rows = this.sqlite.query<{ direction: TrafficDirection, bytes: number, since: string }, []>(
      'select direction, sum(bytes) as bytes, min(day) as since from peer_traffic group by direction',
    ).all()
    const totals = { in: 0, out: 0, since: null as string | null }
    const counted = (day: string) => {
      if (totals.since === null || day < totals.since)
        totals.since = day
    }
    for (const row of rows) {
      totals[row.direction] += row.bytes
      counted(row.since)
    }
    for (const entry of this.pending.values()) {
      totals[entry.direction] += entry.bytes
      counted(entry.day)
    }
    return totals
  }

  /** Totals per party from `fromDay` (inclusive, YYYY-MM-DD) through today. */
  totalsSince(fromDay: string): TrafficTotal[] {
    this.flush()
    return this.sqlite.query<TrafficTotal, [string]>(`
      select direction, party, sum(bytes) as bytes,
        (select label from peer_traffic latest where latest.direction = t.direction and latest.party = t.party order by day desc limit 1) as label
      from peer_traffic t where day >= ? group by direction, party order by bytes desc`).all(fromDay)
  }
}
