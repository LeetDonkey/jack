import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { startPublicServer } from '../lib/public-server'
import { createFileStream } from '../modules/peer/file-stream'
import { parseRangeHeader, PeerController } from '../modules/peer/peer.controller'
import { getPeerRouter } from '../modules/peer/peer.router'
import { TransferMonitor } from '../modules/transfers/transfer-monitor'

describe('parseRangeHeader', () => {
  test('returns null for absent or malformed headers', () => {
    expect(parseRangeHeader(undefined)).toBeNull()
    expect(parseRangeHeader('')).toBeNull()
    expect(parseRangeHeader('bytes=abc')).toBeNull()
    expect(parseRangeHeader('bytes=-')).toBeNull()
    expect(parseRangeHeader('items=0-1')).toBeNull()
  })

  test('parses normal, open-ended, and suffix ranges', () => {
    expect(parseRangeHeader('bytes=2-4')).toEqual({ start: 2, end: 4 })
    expect(parseRangeHeader('bytes=5-')).toEqual({ start: 5, end: undefined })
    expect(parseRangeHeader('bytes=-3')).toEqual({ start: undefined, end: 3 })
  })
})

let tempDir: string
let filePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-range-'))
  filePath = join(tempDir, 'Movie.mkv')
  await Bun.write(filePath, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function controllerForFile() {
  const source = {
    id: 'remote1',
    name: 'My Radarr',
    type: 'radarr',
    canSource: true,
    getFilePath: async () => filePath,
  }
  return new PeerController(() => [source as any])
}

// `body` is now a BunFile/Blob (served via Bun's native backpressure) rather than a
// hand-pumped ReadableStream, so read its bytes directly.
async function bodyBytes(body: Blob): Promise<number[]> {
  return [...new Uint8Array(await body.arrayBuffer())]
}

describe('PeerController.streamFile range handling', () => {
  test('returns a partial slice for a normal range', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=2-4')
    expect(result?.type).toBe('partial')
    if (result?.type !== 'partial')
      throw new Error('expected partial')
    expect({ start: result.start, end: result.end, size: result.size, totalSize: result.totalSize }).toEqual({ start: 2, end: 4, size: 3, totalSize: 10 })
    expect(await bodyBytes(result.body)).toEqual([2, 3, 4])
  })

  test('returns the last N bytes for a suffix range', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=-3')
    if (result?.type !== 'partial')
      throw new Error('expected partial')
    expect(await bodyBytes(result.body)).toEqual([7, 8, 9])
  })

  test('clamps an open-ended range to the file end', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=8-')
    if (result?.type !== 'partial')
      throw new Error('expected partial')
    expect(result.end).toBe(9)
    expect(await bodyBytes(result.body)).toEqual([8, 9])
  })

  test('reports unsatisfiable when start is beyond the file', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=20-30')
    expect(result).toEqual({ type: 'unsatisfiable', totalSize: 10 })
  })

  test('serves the full file when there is no range', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1')
    if (result?.type !== 'full')
      throw new Error('expected full')
    expect(result.size).toBe(10)
    expect(await bodyBytes(result.body)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('returns null when the source is unknown', async () => {
    const result = await controllerForFile().streamFile('unknown:movie:1', 'bytes=0-1')
    expect(result).toBeNull()
  })
})

describe('GET /peer/items/:id/file range responses', () => {
  function appForFile() {
    const app = new Hono()
    app.route('/peer', getPeerRouter(controllerForFile()))
    return app
  }

  test('serves 200 + Accept-Ranges for a full request', async () => {
    const res = await appForFile().request('/peer/items/remote1:movie:1/file')
    expect(res.status).toBe(200)
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Length')).toBe('10')
  })

  test('serves 206 + Content-Range for a valid range', async () => {
    const res = await appForFile().request('/peer/items/remote1:movie:1/file', { headers: { Range: 'bytes=2-4' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 2-4/10')
    expect(res.headers.get('Content-Length')).toBe('3')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]))
  })

  test('serves 416 for an unsatisfiable range', async () => {
    const res = await appForFile().request('/peer/items/remote1:movie:1/file', { headers: { Range: 'bytes=50-60' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */10')
  })

  test('returns 404 for an unknown item', async () => {
    const res = await appForFile().request('/peer/items/unknown:movie:1/file', { headers: { Range: 'bytes=0-1' } })
    expect(res.status).toBe(404)
  })

  test('serves the full file body byte for byte', async () => {
    const res = await appForFile().request('/peer/items/remote1:movie:1/file')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('GET /peer/items/:id/file upload tracking and limits', () => {
  function appWithTransfers(options: { canStart?: boolean } = {}) {
    const monitor = new TransferMonitor({ setInterval: () => 0 as any, clearInterval: () => {} })
    const taken: number[] = []
    const transfers = {
      monitor,
      uploadLimiter: { take: async (bytes: number) => {
        taken.push(bytes)
      } } as any,
      uploadRefusal: () => (options.canStart ?? true) ? null : { status: 503 as const, retryAfterSeconds: 60, message: 'Too many concurrent uploads' },
    }
    const app = new Hono<{ Variables: { apiKeyName?: string } }>()
    app.use('*', async (c, next) => {
      c.set('apiKeyName', 'Nicklas')
      await next()
    })
    app.route('/peer', getPeerRouter(controllerForFile(), transfers))
    return { app, monitor, taken }
  }

  test('answers 429 until midnight past the daily limit, and counts bytes on the friend key', async () => {
    const monitor = new TransferMonitor({ setInterval: () => 0 as any, clearInterval: () => {} })
    const counted: Array<[string, string, string, number]> = []
    let limited = false
    const transfers = {
      monitor,
      uploadLimiter: { take: async () => {} } as any,
      uploadRefusal: (party?: string) => (limited && party === 'key:7' ? { status: 429 as const, retryAfterSeconds: 3600, message: 'Daily limit of 50 GiB reached' } : null),
      ledger: { add: (...args: [string, string, string, number]) => void counted.push(args) } as any,
    }
    const app = new Hono<{ Variables: { apiKeyName?: string, apiKeyId?: number } }>()
    app.use('*', async (c, next) => {
      c.set('apiKeyName', 'Nicklas')
      c.set('apiKeyId', 7)
      await next()
    })
    app.route('/peer', getPeerRouter(controllerForFile(), transfers))

    await (await app.request('/peer/items/remote1:movie:1/file')).arrayBuffer()
    limited = true
    const refused = await app.request('/peer/items/remote1:movie:1/file')

    expect(counted).toEqual([['out', 'key:7', 'Nicklas', 10]])
    expect(refused.status).toBe(429)
    expect(refused.headers.get('Retry-After')).toBe('3600')
  })

  test('answers 503 with Retry-After when every upload slot is taken', async () => {
    const { app } = appWithTransfers({ canStart: false })
    const res = await app.request('/peer/items/remote1:movie:1/file')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('60')
  })

  test('registers the upload under the peer key name and ends it when the body is consumed', async () => {
    const { app, monitor, taken } = appWithTransfers()
    const res = await app.request('/peer/items/remote1:movie:1/file', { headers: { Range: 'bytes=4-' } })

    expect(monitor.list()).toMatchObject([{ direction: 'upload', peer: 'Nicklas', filename: 'Movie.mkv', totalBytes: 10, transferredBytes: 4 }])
    await res.arrayBuffer()
    // Ended: it no longer holds a slot (a ranged upload stays listed briefly for its next window).
    expect(monitor.activeCount('upload')).toBe(0)
    expect(taken.reduce((sum, n) => sum + n, 0)).toBe(6)
  })
})

describe('createFileStream', () => {
  test('reads a large file in chunks and calls onEnd once on completion', async () => {
    const big = new Uint8Array(600 * 1024).map((_, i) => i % 251)
    await Bun.write(filePath, big)
    const chunks: number[] = []
    let ends = 0
    const stream = createFileStream(Bun.file(filePath), { onChunk: n => void chunks.push(n), onEnd: () => ends++ })

    const received = new Uint8Array(await new Response(stream).arrayBuffer())
    expect(received).toEqual(big)
    expect(chunks).toEqual([256 * 1024, 256 * 1024, 88 * 1024])
    expect(ends).toBe(1)
  })

  test('calls onEnd when the consumer cancels', async () => {
    let ends = 0
    const stream = createFileStream(Bun.file(filePath), { onEnd: () => ends++ })
    await stream.cancel()
    expect(ends).toBe(1)
  })
})

describe('file route through the node:http server', () => {
  test('streams a ranged file and ends the upload when the response completes', async () => {
    const big = new Uint8Array(700 * 1024).map((_, i) => i % 253)
    await Bun.write(filePath, big)
    const monitor = new TransferMonitor({ setInterval: () => 0 as any, clearInterval: () => {} })
    const app = new Hono()
    app.route('/peer', getPeerRouter(controllerForFile(), {
      monitor,
      uploadLimiter: { take: async () => {} } as any,
      uploadRefusal: () => null,
    }))
    const server = startPublicServer(app.fetch, 0)
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo

    try {
      const res = await fetch(`http://127.0.0.1:${port}/peer/items/remote1:movie:1/file`, { headers: { Range: 'bytes=100-' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe(`bytes 100-${big.length - 1}/${big.length}`)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(big.slice(100))
      await Bun.sleep(10)
      expect(monitor.activeCount('upload')).toBe(0)
    }
    finally {
      server.close()
    }
  })

  test('a peer that disconnects mid-file frees its upload slot and stops the reads', async () => {
    const big = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 251)
    await Bun.write(filePath, big)
    const monitor = new TransferMonitor({ setInterval: () => 0 as any, clearInterval: () => {} })
    let taken = 0
    const app = new Hono()
    app.route('/peer', getPeerRouter(controllerForFile(), {
      monitor,
      // Slow the upload down so the client can leave halfway.
      uploadLimiter: { take: async (bytes: number) => {
        taken += bytes
        await Bun.sleep(20)
      } } as any,
      uploadRefusal: () => null,
    }))
    const server = startPublicServer(app.fetch, 0)
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo

    try {
      const socket = connect(port, '127.0.0.1')
      socket.write('GET /peer/items/remote1:movie:1/file HTTP/1.1\r\nHost: test\r\n\r\n')
      await new Promise<void>(resolve => socket.once('data', () => resolve()))
      expect(monitor.activeCount('upload')).toBe(1)

      socket.end()
      for (let i = 0; i < 50 && monitor.activeCount('upload') > 0; i++)
        await Bun.sleep(10)
      const takenAtEnd = taken
      await Bun.sleep(200)

      expect(monitor.activeCount('upload')).toBe(0)
      // No more of the file is read once the peer is gone.
      expect(taken).toBe(takenAtEnd)
      expect(taken).toBeLessThan(big.length)
    }
    finally {
      server.close()
    }
  })
})
