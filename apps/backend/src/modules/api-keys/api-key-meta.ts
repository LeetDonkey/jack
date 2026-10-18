import type { Database } from 'bun:sqlite'
import { logger } from '../../logger'

/** How a key was made: by a quick link or an introduction (both for a friend), or null (by hand, or before this was recorded). */
export const API_KEY_ORIGINS = ['quick-link', 'introduction'] as const
export type ApiKeyOrigin = typeof API_KEY_ORIGINS[number]

export interface ApiKeyMetaRow {
  keyId: number
  /** The peer (friend you download from) this key belongs to, set explicitly. */
  peerId: string | null
  origin: ApiKeyOrigin | null
  /** When a friend's jack last authenticated with this key, to the minute. */
  lastUsedAt: string | null
}

/** At most one last-used write per key per this many ms. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000

// Fork-only table, created outside the drizzle migrations (see traffic-ledger.ts),
// so the upstream api_keys table stays untouched. Rows go when their key is revoked.
const CREATE_TABLE = `
  create table if not exists api_key_meta (
    key_id integer primary key,
    peer_id text,
    origin text,
    last_used_at text
  )`
// Named values; `tracking_since` is written once, on the first boot that records
// last use, so a key made before then isn't mistaken for one nobody used.
const CREATE_INFO_TABLE = `
  create table if not exists api_key_meta_info (
    name text primary key,
    value text not null
  )`

interface Row {
  key_id: number
  peer_id: string | null
  origin: string | null
  last_used_at: string | null
}

function toMeta(row: Row): ApiKeyMetaRow {
  return {
    keyId: row.key_id,
    peerId: row.peer_id,
    origin: API_KEY_ORIGINS.includes(row.origin as ApiKeyOrigin) ? row.origin as ApiKeyOrigin : null,
    lastUsedAt: row.last_used_at,
  }
}

/**
 * When a key's `lastUsedAt` starts to count: its creation, or the start of usage
 * tracking for a key made before that. A null `lastUsedAt` means "not used since
 * then", which for an older key is not the same as "never used".
 */
export function lastUsedTrackedSince(createdAt: string, trackingSince: string | null): string {
  return trackingSince && Date.parse(trackingSince) > Date.parse(createdAt) ? trackingSince : createdAt
}

/** What jack knows about an API key beyond the upstream api_keys row. */
export class ApiKeyMeta {
  // Last write per key, so a busy friend costs one write a minute, not one per request.
  private readonly lastWrite = new Map<number, number>()
  private readonly since: string

  constructor(
    private readonly sqlite: Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    sqlite.exec(CREATE_TABLE)
    sqlite.exec(CREATE_INFO_TABLE)
    sqlite.query('insert or ignore into api_key_meta_info (name, value) values (\'tracking_since\', ?)').run(now().toISOString())
    this.since = sqlite.query<{ value: string }, []>('select value from api_key_meta_info where name = \'tracking_since\'').get()!.value
  }

  /** When jack started recording last use (the first boot with this table). A key made earlier may have been used before. */
  trackingSince(): string {
    return this.since
  }

  get(keyId: number): ApiKeyMetaRow {
    const row = this.sqlite.query<Row, [number]>('select * from api_key_meta where key_id = ?').get(keyId)
    return row ? toMeta(row) : { keyId, peerId: null, origin: null, lastUsedAt: null }
  }

  all(): Map<number, ApiKeyMetaRow> {
    return new Map(this.sqlite.query<Row, []>('select * from api_key_meta').all().map(row => [row.key_id, toMeta(row)]))
  }

  /**
   * Record that a key was just used. Writes at most once per key per minute and
   * returns whether it wrote. Never throws: a failed write must not fail the
   * request that used the key.
   */
  touch(keyId: number): boolean {
    const now = this.now()
    const last = this.lastWrite.get(keyId)
    if (last !== undefined && now.getTime() - last < LAST_USED_WRITE_INTERVAL_MS)
      return false
    this.lastWrite.set(keyId, now.getTime())
    try {
      this.sqlite.query('insert into api_key_meta (key_id, last_used_at) values (?, ?) on conflict (key_id) do update set last_used_at = excluded.last_used_at')
        .run(keyId, now.toISOString())
      return true
    }
    catch (err) {
      logger.warn({ err, keyId }, 'Could not record when an API key was used')
      return false
    }
  }

  setPeer(keyId: number, peerId: string | null): void {
    this.sqlite.query('insert into api_key_meta (key_id, peer_id) values (?, ?) on conflict (key_id) do update set peer_id = excluded.peer_id')
      .run(keyId, peerId)
  }

  setOrigin(keyId: number, origin: ApiKeyOrigin): void {
    this.sqlite.query('insert into api_key_meta (key_id, origin) values (?, ?) on conflict (key_id) do update set origin = excluded.origin')
      .run(keyId, origin)
  }

  /** Keys linked to a peer follow it when its url, and so its id, changes. */
  reassignPeer(oldPeerId: string, newPeerId: string): void {
    this.sqlite.query('update api_key_meta set peer_id = ? where peer_id = ?').run(newPeerId, oldPeerId)
  }

  delete(keyId: number): void {
    this.lastWrite.delete(keyId)
    this.sqlite.query('delete from api_key_meta where key_id = ?').run(keyId)
  }
}
