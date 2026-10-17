import type { PieceList } from '../peer/piece-hasher'
import { open } from 'node:fs/promises'
import { PieceMismatchError } from '../../lib/errors/PieceMismatchError'
import { hashPiece, pieceCount } from '../peer/piece-hasher'

const DIGEST_BYTES = 32

/** Fetches bytes `start..end` (inclusive) of the file from one peer. */
export type PieceSource = (start: number, end: number) => Promise<Uint8Array>

export interface VerifyResult {
  pieces: number
  repaired: number
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Check every piece of a complete `.part` against `list`. A piece that doesn't
 * match is fetched again from each of `sources` in turn until one copy matches,
 * then written back in place. Throws PieceMismatchError when no source can
 * supply a matching piece; pieces already repaired stay repaired.
 */
export async function verifyAndRepair(partPath: string, list: PieceList, sources: PieceSource[]): Promise<VerifyResult> {
  const file = Bun.file(partPath)
  if (file.size !== list.size)
    throw new PieceMismatchError(`File is ${file.size} bytes, the piece list describes ${list.size}`)

  const count = pieceCount(list.size, list.pieceBytes)
  let repaired = 0
  for (let i = 0; i < count; i++) {
    const start = i * list.pieceBytes
    const end = Math.min(start + list.pieceBytes, list.size) - 1
    const expected = list.hashes.subarray(i * DIGEST_BYTES, (i + 1) * DIGEST_BYTES)
    const local = new Uint8Array(await file.slice(start, end + 1).arrayBuffer())
    if (equalBytes(hashPiece(local), expected))
      continue

    let fixed = false
    for (const source of sources) {
      const copy = await source(start, end).catch(() => null)
      if (!copy || !equalBytes(hashPiece(copy), expected))
        continue
      const handle = await open(partPath, 'r+')
      try {
        await handle.write(copy, 0, copy.length, start)
        await handle.datasync()
      }
      finally {
        await handle.close()
      }
      fixed = true
      repaired++
      break
    }
    if (!fixed)
      throw new PieceMismatchError(`Piece ${i} (bytes ${start}-${end}) doesn't match the peer's hash, and no peer sent a matching copy`)
  }
  return { pieces: count, repaired }
}
