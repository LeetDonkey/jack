import type { Database } from 'bun:sqlite'
import type { SecurityConfig } from '../../lib/config'
import { inRanges, PRIVATE_RANGES } from '../../lib/net/ip'
import { logger } from '../../logger'

export interface BanEntry {
  ip: string
  bannedAt: string
  bannedUntil: string
  failures: number
  reason: string
}

export interface FailingAddress {
  ip: string
  failures: number
  lastAt: string
}

// Fork-only table, created outside the drizzle migrations (see traffic-ledger.ts).
const CREATE_TABLE = `
  create table if not exists ip_bans (
    ip text primary key, banned_at text not null, banned_until text not null,
    failures integer not null, reason text not null)`

// Bound on addresses tracked for failures, so a flood of distinct addresses can't grow memory without limit.
const MAX_TRACKED = 10_000

interface BanRow {
  ip: string
  banned_at: string
  banned_until: string
  failures: number
  reason: string
}

const toEntry = (row: BanRow): BanEntry => ({ ip: row.ip, bannedAt: row.banned_at, bannedUntil: row.banned_until, failures: row.failures, reason: row.reason })

/**
 * fail2ban for the public port: an address that fails authentication
 * `maxFailures` times within `windowMinutes` is refused everything for
 * `banMinutes`. Bans are stored, so a restart doesn't lift them. Addresses in
 * `neverBan` (by default the LAN and loopback) are never counted.
 */
export class BanList {
  private readonly failures = new Map<string, number[]>()
  private readonly listeners = new Set<(ban: BanEntry) => void>()

  constructor(
    private readonly sqlite: Database,
    private readonly config: () => SecurityConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    sqlite.exec(CREATE_TABLE)
  }

  onBan(listener: (ban: BanEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  exempt(ip: string): boolean {
    return inRanges(ip, this.config().neverBan ?? PRIVATE_RANGES)
  }

  /** The active ban for `ip`, or null. Bans apply even if banning was switched off later, until lifted or expired. */
  activeBan(ip: string): BanEntry | null {
    const row = this.sqlite.query<BanRow, [string]>('select * from ip_bans where ip = ?').get(ip)
    if (!row)
      return null
    if (Date.parse(row.banned_until) <= this.now().getTime()) {
      this.sqlite.query('delete from ip_bans where ip = ?').run(ip)
      return null
    }
    return toEntry(row)
  }

  /** Count a failed attempt. Returns the new ban when this one tipped `ip` over the limit. */
  recordFailure(ip: string, reason: string): BanEntry | null {
    const config = this.config()
    if (!config.banEnabled || this.exempt(ip) || this.activeBan(ip))
      return null
    const now = this.now().getTime()
    const windowStart = now - config.windowMinutes * 60_000
    const recent = (this.failures.get(ip) ?? []).filter(t => t > windowStart)
    recent.push(now)
    this.failures.delete(ip)
    this.failures.set(ip, recent)
    this.trim(windowStart)
    if (recent.length < config.maxFailures)
      return null

    this.failures.delete(ip)
    const ban: BanEntry = {
      ip,
      bannedAt: new Date(now).toISOString(),
      bannedUntil: new Date(now + config.banMinutes * 60_000).toISOString(),
      failures: recent.length,
      reason,
    }
    this.sqlite.query(`insert into ip_bans (ip, banned_at, banned_until, failures, reason) values (?, ?, ?, ?, ?)
      on conflict (ip) do update set banned_at = excluded.banned_at, banned_until = excluded.banned_until,
        failures = excluded.failures, reason = excluded.reason`)
      .run(ban.ip, ban.bannedAt, ban.bannedUntil, ban.failures, ban.reason)
    logger.warn({ ip, failures: ban.failures, bannedUntil: ban.bannedUntil, reason }, 'Banned an address after repeated failed authentication')
    for (const listener of this.listeners) {
      try {
        listener(ban)
      }
      catch {}
    }
    return ban
  }

  // Drop addresses with no failures left in the window, then the oldest-tracked beyond the cap.
  private trim(windowStart: number): void {
    for (const [ip, times] of this.failures) {
      if (times.every(t => t <= windowStart))
        this.failures.delete(ip)
    }
    while (this.failures.size > MAX_TRACKED)
      this.failures.delete(this.failures.keys().next().value!)
  }

  /** Seconds until `ban` ends, by this list's clock. */
  secondsLeft(ban: BanEntry): number {
    return Math.max(1, Math.ceil((Date.parse(ban.bannedUntil) - this.now().getTime()) / 1000))
  }

  list(): BanEntry[] {
    this.sqlite.query('delete from ip_bans where banned_until <= ?').run(this.now().toISOString())
    return this.sqlite.query<BanRow, []>('select * from ip_bans order by banned_at desc').all().map(toEntry)
  }

  /** Addresses with failures in the current window that aren't banned (yet). */
  failing(): FailingAddress[] {
    const windowStart = this.now().getTime() - this.config().windowMinutes * 60_000
    return Array.from(this.failures.entries(), ([ip, times]) => ({ ip, times: times.filter(t => t > windowStart) }))
      .filter(f => f.times.length > 0)
      .map(f => ({ ip: f.ip, failures: f.times.length, lastAt: new Date(Math.max(...f.times)).toISOString() }))
      .sort((a, b) => b.failures - a.failures)
  }

  unban(ip: string): boolean {
    this.failures.delete(ip)
    return this.sqlite.query('delete from ip_bans where ip = ?').run(ip).changes > 0
  }
}
