import type { AuthVariables } from '../../middleware/require-auth'
import type { TransfersService } from '../transfers/transfers.service'
import type { PeerController } from './peer.controller'
import type { PieceHasher } from './piece-hasher'
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi'
import z from 'zod'
import { createFileStream } from './file-stream'

// Strip characters that could break out of the quoted filename or inject extra
// response headers (CR/LF/quote). The name comes from a trusted *arr basename, so
// this is defense-in-depth.
const UNSAFE_FILENAME_CHARS = /["\r\n]/g
function safeFilename(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, '')
}

// Seconds a peer is told to wait while a file's piece hashes are computed.
const PIECES_PENDING_RETRY_AFTER_S = 30

export function getPeerRouter(
  controller: PeerController,
  transfers?: Pick<TransfersService, 'monitor' | 'uploadLimiter' | 'uploadRefusal' | 'ledger'>,
  pieceHasher?: Pick<PieceHasher, 'get'>,
) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/items/:itemId/pieces', describeRoute({
    tags: ['Peer'],
    summary: 'Piece hashes of the release file',
    description: 'SHA-256 of every 16 MiB piece of the file, so a downloader can verify what it fetched and recognise the same file at another peer. Computed in the background on first request.',
    security: [{ 'X-Api-Key': [] }],
    responses: {
      200: { description: '`{ size, pieceBytes, algorithm: "sha256", hashes }` with `hashes` the base64 of the concatenated digests' },
      202: { description: 'Still hashing; retry after the Retry-After delay' },
      404: { description: 'No item with this id, its file is missing, or this jack does not hash files' },
    },
  }), async (c) => {
    const path = pieceHasher ? await controller.filePathFor(c.req.param('itemId')) : null
    const pieces = path ? await pieceHasher!.get(path).catch(() => null) : null
    if (!pieces)
      return c.json({ error: 'File not found' }, 404)
    if (pieces === 'pending')
      return c.json({ pending: true }, 202, { 'Retry-After': String(PIECES_PENDING_RETRY_AFTER_S) })
    return c.json({ size: pieces.size, pieceBytes: pieces.pieceBytes, algorithm: 'sha256', hashes: Buffer.from(pieces.hashes).toString('base64') })
  })

  app.get(
    '/search',
    describeRoute({
      tags: ['Peer'],
      summary: 'Search this library',
      description: 'Search the local Radarr/Sonarr libraries by external id. Only movies/episodes that have files are returned. Serves empty results when no local source is configured.',
      security: [{ 'X-Api-Key': [] }],
      responses: {
        200: {
          description: 'Matching releases, mirroring the *arr file metadata',
          content: { 'application/json': { schema: resolver(z.object({ items: z.array(z.record(z.string(), z.unknown())) })) } },
        },
      },
    }),
    zValidator('query', z.object({
      imdbId: z.string().optional(),
      tmdbId: z.string().optional(),
      tvdbId: z.string().optional(),
      season: z.coerce.number().int().optional(),
      episode: z.coerce.number().int().optional(),
      // ISO time: with no id, return only files added since then (the RSS feed).
      since: z.string().optional(),
    })),
    async (c) => {
      const params = c.req.valid('query')
      const results = await controller.search(params)
      return c.json({ items: results })
    },
  )

  app.get('/items/:itemId', describeRoute({
    tags: ['Peer'],
    summary: 'Get release metadata',
    security: [{ 'X-Api-Key': [] }],
    responses: {
      200: { description: 'Release metadata for the item' },
      404: { description: 'No item with this id' },
    },
  }), async (c) => {
    const { itemId } = c.req.param()
    const item = await controller.getItem(itemId)
    if (!item) {
      return c.json({ error: 'Not found' }, 404)
    }
    return c.json(item)
  })

  app.get('/items/:itemId/file', describeRoute({
    tags: ['Peer'],
    summary: 'Stream the release file',
    description: 'Streams the file straight from disk at the path the local *arr reports. Supports HTTP Range requests for resumable transfers.',
    security: [{ 'X-Api-Key': [] }],
    responses: {
      200: { description: 'Full file stream', content: { 'application/octet-stream': {} } },
      206: { description: 'Partial content for a satisfiable Range request', content: { 'application/octet-stream': {} } },
      404: { description: 'No item with this id, or its file is missing on disk' },
      416: { description: 'Unsatisfiable Range request' },
      429: { description: 'This friend\'s daily upload limit is reached; retry after the Retry-After delay (local midnight)' },
      503: { description: 'Every upload slot (or every slot for this friend) is in use; retry after the Retry-After delay' },
    },
  }), async (c) => {
    // Limits are per friend: one api key is one friend. The master key has none.
    const apiKeyId = c.get('apiKeyId')
    const party = apiKeyId != null ? `key:${apiKeyId}` : undefined
    const label = c.get('apiKeyName') ?? 'unknown peer'
    const refusal = transfers?.uploadRefusal(party)
    if (refusal) {
      return c.json({ error: refusal.message }, refusal.status, {
        'Retry-After': String(refusal.retryAfterSeconds),
      })
    }

    const { itemId } = c.req.param()
    const result = await controller.streamFile(itemId, c.req.header('Range'))

    if (!result) {
      return c.json({ error: 'File not found' }, 404)
    }

    if (result.type === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${result.totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }

    // Track the upload and pace it through the shared upload limit. The transfer
    // ends when the stream completes, errors, or the peer disconnects.
    // Under node:http (Bun) a client that disconnects mid-stream neither cancels the
    // body nor aborts the request signal; only the request's 'close' tells, and
    // without it the upload keeps reading the file into nowhere and holds its slot.
    const disconnected = new AbortController()
    const env = c.env as { incoming?: { once: (event: string, fn: () => void) => void }, outgoing?: { writableFinished?: boolean } } | undefined
    env?.incoming?.once('close', () => {
      if (!env.outgoing?.writableFinished)
        disconnected.abort(new Error('Peer disconnected'))
    })
    const signal = AbortSignal.any([c.req.raw.signal, disconnected.signal])
    const upload = transfers?.monitor.start({
      direction: 'upload',
      peer: label,
      filename: result.filename,
      totalBytes: result.type === 'partial' ? result.totalSize : result.size,
      offsetBytes: result.type === 'partial' ? result.start : 0,
      party,
      // A peer fetching in Range windows stays one entry in the transfers view.
      resumeKey: result.type === 'partial' ? `${party ?? 'master'}:${itemId}` : undefined,
    })
    const body = createFileStream(result.body, {
      onChunk: async (bytes) => {
        await transfers?.uploadLimiter.take(bytes, signal)
        upload?.add(bytes)
        transfers?.ledger?.add('out', party ?? 'master', label, bytes)
      },
      onEnd: () => upload?.end(),
      signal,
    })

    if (result.type === 'partial') {
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(result.size),
          'Content-Range': `bytes ${result.start}-${result.end}/${result.totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `attachment; filename="${safeFilename(result.filename)}"`,
        },
      })
    }

    return new Response(body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(result.size),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${safeFilename(result.filename)}"`,
      },
    })
  })

  return app
}
