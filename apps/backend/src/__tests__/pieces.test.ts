import type { PeerConnector } from '../lib/servers/peer'
import type { PieceList } from '../modules/peer/piece-hasher'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { PieceMismatchError } from '../lib/errors/PieceMismatchError'
import { DownloadSources } from '../modules/downloads/download-sources'
import { verifyAndRepair } from '../modules/downloads/piece-verifier'
import { getPeerRouter } from '../modules/peer/peer.router'
import { hashPiece, PIECE_BYTES, PieceHasher, samePieces } from '../modules/peer/piece-hasher'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jack-pieces-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// A piece list over `bytes` with small pieces, as a peer would send it.
function listOf(bytes: Uint8Array, pieceBytes: number): PieceList {
  const count = Math.ceil(bytes.length / pieceBytes)
  const hashes = new Uint8Array(count * 32)
  for (let i = 0; i < count; i++)
    hashes.set(hashPiece(bytes.subarray(i * pieceBytes, (i + 1) * pieceBytes)), i * 32)
  return { size: bytes.length, pieceBytes, hashes }
}

describe('PieceHasher', () => {
  test('hashes a file in the background, caches it, and hashes again after a change', async () => {
    const path = join(dir, 'movie.mkv')
    const content = new Uint8Array(PIECE_BYTES + 1000).map((_, i) => i % 251)
    await writeFile(path, content)
    const hasher = new PieceHasher(new Database(':memory:'))

    expect(await hasher.get(path)).toBe('pending')
    await hasher.idle()
    const list = await hasher.get(path)

    expect(list).toEqual(listOf(content, PIECE_BYTES))

    await utimes(path, new Date(), new Date(Date.now() + 5000))
    expect(await hasher.get(path)).toBe('pending')
  })
})

describe('verifyAndRepair', () => {
  const good = new Uint8Array(10).map((_, i) => i)

  test('passes a correct file and repairs a bad piece from the first source with a matching copy', async () => {
    const path = join(dir, 'movie.mkv.part')
    const bad = good.slice()
    bad[5] = 99
    await writeFile(path, bad)
    const list = listOf(good, 4)
    const asked: string[] = []
    const result = await verifyAndRepair(path, list, [
      async () => {
        asked.push('broken peer')
        throw new Error('down')
      },
      async (start, end) => {
        asked.push(`good peer ${start}-${end}`)
        return good.slice(start, end + 1)
      },
    ])

    expect(result).toEqual({ pieces: 3, repaired: 1 })
    expect(asked).toEqual(['broken peer', 'good peer 4-7'])
    expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(good)
  })

  test('throws PieceMismatchError when no source has a matching piece', async () => {
    const path = join(dir, 'movie.mkv.part')
    const bad = good.slice()
    bad[9] = 0
    await writeFile(path, bad)

    const verify = verifyAndRepair(path, listOf(good, 4), [async (start, end) => bad.slice(start, end + 1)])

    await expect(verify).rejects.toBeInstanceOf(PieceMismatchError)
  })
})

describe('DownloadSources', () => {
  const content = new Uint8Array(12).map((_, i) => i)
  const same = listOf(content, 4)
  const other = listOf(new Uint8Array(12), 4)
  const release = { size: 12, tmdbId: 42 }

  function peer(id: string, pieces: Record<string, PieceList | 'pending' | null>, items: Array<{ id: string, size: number }> = []): PeerConnector {
    return {
      id,
      name: id,
      getPieces: async (itemId: string) => pieces[itemId] ?? null,
      searchByTmdbId: async () => items,
      searchByTvdbId: async () => [],
    } as unknown as PeerConnector
  }

  test('after a failure, continues from a peer whose file has the same piece hashes', async () => {
    const primary = peer('a', { 'a:1': same })
    const mirror = peer('b', { 'b:9': same }, [{ id: 'b:9', size: 12 }])
    const different = peer('c', { 'c:3': other }, [{ id: 'c:3', size: 12 }])
    const wrongSize = peer('d', { 'd:4': same }, [{ id: 'd:4', size: 13 }])
    const sources = new DownloadSources({ peer: primary, itemId: 'a:1' }, release, () => [primary, mirror, different, wrongSize])

    expect(sources.current.peer.id).toBe('a')
    expect(await sources.advance()).toEqual({ peer: mirror, itemId: 'b:9' })
    expect((await sources.advance()).peer.id).toBe('a')
  })

  test('stays with the primary while it is still hashing, and looks again on the next failure', async () => {
    const answers: Array<PieceList | 'pending'> = ['pending', same]
    const primary = { ...peer('a', {}), getPieces: async () => answers.shift() ?? same } as unknown as PeerConnector
    const mirror = peer('b', { 'b:9': same }, [{ id: 'b:9', size: 12 }])
    const sources = new DownloadSources({ peer: primary, itemId: 'a:1' }, release, () => [primary, mirror])

    expect((await sources.advance()).peer.id).toBe('a')
    expect(await sources.pieceList(0)).toEqual(same)
  })

  test('has no piece list when no peer hashes files (older jacks)', async () => {
    const primary = peer('a', {})
    const sources = new DownloadSources({ peer: primary, itemId: 'a:1' }, release, () => [primary])
    expect(await sources.pieceList(60_000)).toBeNull()
  })

  test('samePieces compares size, piece size and every hash', () => {
    expect(samePieces(same, listOf(content, 4))).toBe(true)
    expect(samePieces(same, other)).toBe(false)
    expect(samePieces(same, listOf(content, 6))).toBe(false)
  })
})

describe('GET /peer/items/:id/pieces', () => {
  function app(answer: PieceList | 'pending' | null) {
    const controller = { filePathFor: async () => (answer === null ? null : '/film/movie.mkv') } as any
    const hasher = { get: async () => answer! }
    const hono = new Hono()
    hono.route('/peer', getPeerRouter(controller, undefined, hasher))
    return hono
  }

  test('answers 202 with Retry-After while hashing, then the list', async () => {
    const pending = await app('pending').request('/peer/items/r:movie:1/pieces')
    expect(pending.status).toBe(202)
    expect(pending.headers.get('Retry-After')).toBe('30')

    const list = listOf(new Uint8Array([1, 2, 3, 4, 5]), 4)
    const ready = await app(list).request('/peer/items/r:movie:1/pieces')
    const body = await ready.json() as { size: number, pieceBytes: number, algorithm: string, hashes: string }
    expect(body).toMatchObject({ size: 5, pieceBytes: 4, algorithm: 'sha256' })
    expect([...Buffer.from(body.hashes, 'base64')]).toEqual([...list.hashes])
  })

  test('answers 404 for an unknown item', async () => {
    expect((await app(null).request('/peer/items/r:movie:1/pieces')).status).toBe(404)
  })
})
