import type { Database } from 'bun:sqlite'

// Fork-only table, created outside the drizzle migrations (see traffic-ledger.ts):
// small facts about this install that outlive a restart.
const CREATE_TABLE = 'create table if not exists jack_meta (key text primary key, value text not null)'

/** Key-value facts about this install, stored in the database (table jack_meta). */
export class JackMeta {
  constructor(private readonly sqlite: Database) {
    sqlite.exec(CREATE_TABLE)
  }

  get(key: string): string | null {
    return this.sqlite.query<{ value: string }, [string]>('select value from jack_meta where key = ?').get(key)?.value ?? null
  }

  set(key: string, value: string): void {
    this.sqlite.query('insert into jack_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(key, value)
  }

  /** Runs `fn` in one transaction, so a crash can't leave half of it stored. */
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)()
  }
}
