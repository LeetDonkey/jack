import type { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import { logger } from '../../logger'

/** Files are hashed in pieces of this size; the last piece may be shorter. */
export const PIECE_BYTES = 16 * 1024 * 1024
const DIGEST_BYTES = 32

export interface PieceList {
  size: number
  pieceBytes: number
  /** SHA-256 of every piece, concatenated (32 bytes each). */
  hashes: Uint8Array
}

export function pieceCount(size: number, pieceBytes = PIECE_BYTES): number {
  return Math.ceil(size / pieceBytes)
}

/** Whether two piece lists describe byte-identical files. */
export function samePieces(a: PieceList, b: PieceList): boolean {
  return a.size === b.size && a.pieceBytes === b.pieceBytes && a.hashes.length === b.hashes.length
    && a.hashes.every((byte, i) => byte === b.hashes[i])
}

export function hashPiece(bytes: Uint8Array): Uint8Array {
  return new Bun.CryptoHasher('sha256').update(bytes).digest() as Uint8Array
}

// Fork-only table, created outside the drizzle migrations (see traffic-ledger.ts).
const CREATE_TABLE = `
  create table if not exists piece_hashes (
    path text primary key,
    size integer not null,
    mtime_ms integer not null,
    piece_bytes integer not null,
    hashes blob not null,
    computed_at text not null
  )`

/**
 * Piece hashes of the files this instance shares, so a peer can tell that a file
 * here is byte-identical to one elsewhere (Radarr renames files, so names say
 * nothing) and verify every piece it downloads. Hashing reads the whole file, so
 * it runs in the background, one file at a time, and the result is cached until
 * the file's size or mtime changes.
 */
export class PieceHasher {
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private working = false

  constructor(private readonly sqlite: Database) {
    sqlite.exec(CREATE_TABLE)
  }

  /** The cached list for `path`, or 'pending' after queueing it for hashing. */
  async get(path: string): Promise<PieceList | 'pending'> {
    const info = await stat(path)
    const row = this.sqlite.query<{ size: number, mtime_ms: number, piece_bytes: number, hashes: Uint8Array }, [string]>(
      'select size, mtime_ms, piece_bytes, hashes from piece_hashes where path = ?',
    ).get(path)
    if (row && row.size === info.size && row.mtime_ms === Math.trunc(info.mtimeMs) && row.piece_bytes === PIECE_BYTES)
      return { size: row.size, pieceBytes: row.piece_bytes, hashes: new Uint8Array(row.hashes) }
    this.enqueue(path)
    return 'pending'
  }

  /** Resolves once nothing is queued or being hashed (for tests). */
  async idle(): Promise<void> {
    while (this.working || this.queue.length > 0)
      await Bun.sleep(5)
  }

  private enqueue(path: string): void {
    if (this.queued.has(path))
      return
    this.queued.add(path)
    this.queue.push(path)
    if (!this.working)
      void this.work()
  }

  private async work(): Promise<void> {
    this.working = true
    try {
      while (this.queue.length > 0) {
        const path = this.queue.shift()!
        try {
          await this.compute(path)
        }
        catch (err) {
          logger.warn({ path, err }, 'Could not hash file for peers')
        }
        finally {
          this.queued.delete(path)
        }
      }
    }
    finally {
      this.working = false
    }
  }

  private async compute(path: string): Promise<void> {
    const started = Date.now()
    const before = await stat(path)
    const file = Bun.file(path)
    const count = pieceCount(before.size)
    const hashes = new Uint8Array(count * DIGEST_BYTES)
    for (let i = 0; i < count; i++) {
      const start = i * PIECE_BYTES
      const piece = new Uint8Array(await file.slice(start, Math.min(start + PIECE_BYTES, before.size)).arrayBuffer())
      hashes.set(hashPiece(piece), i * DIGEST_BYTES)
    }
    const after = await stat(path)
    // The file changed while it was read (an upgrade replaced it): drop the result.
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      return
    this.sqlite.query(`
      insert into piece_hashes (path, size, mtime_ms, piece_bytes, hashes, computed_at) values (?, ?, ?, ?, ?, ?)
      on conflict (path) do update set size = excluded.size, mtime_ms = excluded.mtime_ms, piece_bytes = excluded.piece_bytes,
        hashes = excluded.hashes, computed_at = excluded.computed_at`)
      .run(path, before.size, Math.trunc(before.mtimeMs), PIECE_BYTES, hashes, new Date().toISOString())
    logger.info({ path, size: before.size, pieces: count, ms: Date.now() - started }, 'Hashed file for peers')
  }
}
