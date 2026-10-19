import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'

export type AppDatabase = BunSQLiteDatabase<typeof schema>

export interface DatabaseHandle {
  db: AppDatabase
  sqlite: Database
  path: string
  /** The database already had migrations applied when this boot opened it: an install from an earlier boot, not a new one. */
  preexisting: boolean
  close: () => void
}

// Migrations live at apps/backend/drizzle. import.meta.dir is
// apps/backend/src/database, so go up two levels. Resolving relative to this
// module (not cwd) keeps it correct under `bun src/index.ts` and bun:test.
export const MIGRATIONS_FOLDER = join(import.meta.dir, '../../drizzle')

export function getDatabasePath(appConfigPath: string) {
  return join(dirname(appConfigPath), 'database.sqlite')
}

// Applies all pending Drizzle migrations. Idempotent: drizzle tracks applied
// migrations in __drizzle_migrations, so this is safe to run on every boot and
// in every test against a fresh in-memory DB.
export function runMigrations(db: AppDatabase) {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}

/** Whether drizzle applied any migration to this database before (checked before runMigrations). */
export function hasAppliedMigrations(sqlite: Database): boolean {
  const table = sqlite.query('select 1 from sqlite_master where type = \'table\' and name = \'__drizzle_migrations\'').get()
  if (!table)
    return false
  return (sqlite.query<{ n: number }, []>('select count(*) as n from __drizzle_migrations').get()?.n ?? 0) > 0
}

export async function openDatabase({ appConfigPath }: { appConfigPath: string }): Promise<DatabaseHandle> {
  const path = getDatabasePath(appConfigPath)
  await mkdir(dirname(path), { recursive: true })

  const sqlite = new Database(path)
  sqlite.exec('pragma journal_mode = WAL')
  sqlite.exec('pragma foreign_keys = ON')

  const db = drizzle({ client: sqlite, schema })
  const preexisting = hasAppliedMigrations(sqlite)
  runMigrations(db)

  return {
    db,
    sqlite,
    path,
    preexisting,
    close: () => sqlite.close(),
  }
}
