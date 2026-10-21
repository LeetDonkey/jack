import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PeerConnector } from '../lib/servers/peer'

// These tests need Bun's native fetch body against a real socket: a mocked
// fetch (msw) hands back a JavaScript stream, which doesn't have the bug.
//
// Bun 1.3: when a fetch body finishes arriving after `response.body` was first
// read but before `getReader()`, the stream hands over the whole body as one
// chunk, and the reader's `releaseLock()` throws "TypeError: undefined is not a
// function". With a download limit, that one chunk is paced for size / rate
// seconds, so the throw came long after the .part was complete.

const FILE = new Uint8Array(64 * 1024).map((_, i) => i % 251)

function markInitialized<T extends object>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return connector
}

let server: Server
let baseUrl: string
// The first response sends half its body, then waits for this before the rest.
let sendRest: PromiseWithResolvers<void>
let requests: string[]

function parseRange(header: string | undefined, size: number): { start: number, end: number } | null {
  const match = header?.match(/^bytes=(\d+)-(\d*)$/)
  if (!match)
    return null
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return { start, end }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const first = requests.length === 0
  requests.push(req.headers.range ?? 'none')
  const range = parseRange(req.headers.range, FILE.byteLength)
  const body = range ? FILE.subarray(range.start, range.end + 1) : FILE
  res.writeHead(range ? 206 : 200, {
    'Content-Length': String(body.byteLength),
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${FILE.byteLength}` } : {}),
  })
  if (!first) {
    res.end(body)
    return
  }
  const half = Math.floor(body.byteLength / 2)
  res.write(body.subarray(0, half))
  await sendRest.promise
  res.end(body.subarray(half))
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  sendRest?.resolve()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

let dir: string

beforeEach(async () => {
  sendRest = Promise.withResolvers<void>()
  requests = []
  dir = await mkdtemp(join(tmpdir(), 'jack-peer-buffered-'))
})

afterEach(async () => {
  sendRest.resolve()
  await rm(dir, { recursive: true, force: true })
})

// The headers event comes after downloadFile has read `response.body` and
// before it takes the reader: let the rest of the body arrive in between.
async function letBodyFinish(event: { type: string }) {
  if (event.type !== 'headers')
    return
  sendRest.resolve()
  await Bun.sleep(150)
}

describe('PeerConnector.downloadFile with a body that finished before the read', () => {
  test('completes a single-response download', async () => {
    const peer = markInitialized(new PeerConnector({ url: baseUrl, apiKey: 'peer-api-key', name: 'Bob' }))
    const destPath = join(dir, 'Movie.mkv')
    const chunks: number[] = []

    await peer.downloadFile('e861452b:movie:3', destPath, {
      releaseSize: FILE.byteLength,
      onProgress: letBodyFinish,
      onChunk: (bytes) => { chunks.push(bytes) },
    })

    expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(FILE)
    expect(await Bun.file(`${destPath}.part`).exists()).toBe(false)
    // One chunk: the body had arrived in full before the read, as in the bug.
    expect(chunks).toEqual([FILE.byteLength])
    expect(requests).toEqual(['none'])
  })

  test('moves on to the next window when the first one finished before the read', async () => {
    const peer = markInitialized(new PeerConnector({ url: baseUrl, apiKey: 'peer-api-key', name: 'Bob' }))
    const destPath = join(dir, 'Movie.mkv')
    const windowBytes = FILE.byteLength / 2

    await peer.downloadFile('e861452b:movie:3', destPath, {
      releaseSize: FILE.byteLength,
      windowBytes,
      onProgress: letBodyFinish,
    })

    expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(FILE)
    expect(requests).toEqual([`bytes=0-${windowBytes - 1}`, `bytes=${windowBytes}-${FILE.byteLength - 1}`])
  })
})
