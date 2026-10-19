import type { IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { onClientGone, relayBody } from './relay'

// A fake jack on a raw socket, so a test can cut a response off mid-body.
function chunk(text: string): string {
  return `${new TextEncoder().encode(text).length.toString(16)}\r\n${text}\r\n`
}

const HEAD = 'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

async function listen(server: { listen: (port: number, host: string) => unknown, address: () => unknown, close: () => unknown }): Promise<number> {
  server.listen(0, '127.0.0.1')
  for (let i = 0; i < 50 && !server.address(); i++)
    await Bun.sleep(10)
  cleanups.push(() => server.close())
  return (server.address() as AddressInfo).port
}

// The fake jack: `respond` writes to each connection it accepts. Tracks the open
// ones, and counts all it accepted.
async function fakeJack(respond: (socket: Socket) => void) {
  const open = new Set<Socket>()
  const counts = { accepted: 0 }
  const server = createTcpServer((socket) => {
    counts.accepted++
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
    socket.once('data', () => respond(socket))
  })
  const port = await listen(server)
  cleanups.push(() => {
    for (const socket of open)
      socket.destroy()
  })
  return { url: `http://127.0.0.1:${port}/`, open, counts }
}

// The SSE stream jack sends: open, then a ping every 50 ms until the call ends.
function pings(socket: Socket) {
  socket.write(HEAD + chunk(': open\n\n'))
  const ping = setInterval(() => socket.write(chunk('event: ping\ndata: \n\n')), 50)
  socket.on('close', () => clearInterval(ping))
}

interface ProxyOptions {
  // Awaited before onClientGone, like resolveKey and readRawBody in the handler.
  before?: (req: IncomingMessage) => Promise<void>
  // Counts handled requests, once each has returned.
  finished?: { count: number }
}

// The proxy, the way server/api/management/[...path].ts uses the helpers.
async function proxy(upstreamUrl: string, { before, finished }: ProxyOptions = {}) {
  const server = createServer(async (req, res) => {
    await before?.(req)
    const upstream = new AbortController()
    const stop = onClientGone(req, res, () => upstream.abort())
    try {
      const answer = await fetch(upstreamUrl, { signal: upstream.signal })
      res.statusCode = answer.status
      res.setHeader('content-type', answer.headers.get('content-type') ?? 'text/plain')
      if (!await relayBody(answer.body, res, upstream.signal))
        upstream.abort()
    }
    catch {
      res.statusCode = 503
      res.end()
    }
    finally {
      stop()
      if (finished)
        finished.count++
    }
  })
  return `http://127.0.0.1:${await listen(server)}/`
}

async function readAll(res: Response, timeoutMs: number): Promise<{ text: string, ended: 'done' | 'error' | 'timeout' }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const timeout = Bun.sleep(timeoutMs).then(() => 'timeout' as const)
  for (;;) {
    const next = await Promise.race([reader.read().catch(() => 'error' as const), timeout])
    if (next === 'timeout' || next === 'error') {
      reader.cancel().catch(() => {})
      return { text, ended: next }
    }
    if (next.done)
      return { text, ended: 'done' }
    text += decoder.decode(next.value)
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await Bun.sleep(20)) {
    if (check())
      return true
  }
  return check()
}

describe('relayBody', () => {
  test('passes a complete body through and ends the response', async () => {
    const jack = await fakeJack((socket) => {
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{"ok":true}`)
    })
    const res = await fetch(await proxy(jack.url))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ ok: true })
  })

  test.each(['reset', 'close'] as const)('drops the browser\'s stream when jack\'s connection is cut (%s)', async (how) => {
    const jack = await fakeJack((socket) => {
      socket.write(HEAD + chunk(': open\n\n') + chunk('data: {"n":1}\n\n'))
      setTimeout(() => how === 'reset' ? socket.resetAndDestroy() : socket.end(), 100)
    })
    const res = await fetch(await proxy(jack.url))
    const { text, ended } = await readAll(res, 3_000)
    expect(text).toContain('data: {"n":1}')
    expect(ended).not.toBe('timeout')
  })

  test('closes the connection to jack when the browser leaves', async () => {
    const jack = await fakeJack(pings)
    const url = await proxy(jack.url)

    const browser = new AbortController()
    const res = await fetch(url, { signal: browser.signal })
    await res.body!.getReader().read()
    expect(jack.open.size).toBe(1)
    browser.abort()

    expect(await waitFor(() => jack.open.size === 0, 3_000)).toBe(true)
  })

  test('never calls jack for a browser that left before the handler got to it', async () => {
    const jack = await fakeJack(pings)
    const finished = { count: 0 }
    // The close lands while the handler awaits (the session unseal in cookie
    // mode), so the connection's events have fired before onClientGone listens.
    const url = new URL(await proxy(jack.url, {
      finished,
      before: async (req) => {
        await waitFor(() => req.socket.destroyed, 3_000)
      },
    }))

    for (let i = 0; i < 3; i++) {
      const browser = connect(Number(url.port), url.hostname, () => {
        browser.write(`GET /stream HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/event-stream\r\n\r\n`)
        browser.destroy()
      })
      browser.on('error', () => {})
    }

    expect(await waitFor(() => finished.count === 3, 3_000)).toBe(true)
    expect(jack.counts.accepted).toBe(0)
  })
})

describe('onClientGone', () => {
  test('keeps a request whose body was read while the browser waits', async () => {
    const jack = await fakeJack((socket) => {
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{"ok":true}`)
    })
    // Like readRawBody on a mutation. Bun then sets req.destroyed, though the
    // browser is still there.
    const url = await proxy(jack.url, {
      before: async (req) => {
        const body: unknown[] = []
        for await (const part of req)
          body.push(part)
        await Bun.sleep(20)
      },
    })

    const res = await fetch(url, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('reports a connection that closed before it was called, right away', async () => {
    const gone: string[] = []
    const server = createServer(async (req, res) => {
      await waitFor(() => req.socket.destroyed, 3_000)
      const stop = onClientGone(req, res, () => gone.push(req.url ?? ''))
      gone.push('returned')
      stop()
      res.end()
    })
    const url = new URL(await listen(server).then(port => `http://127.0.0.1:${port}/`))

    const browser = connect(Number(url.port), url.hostname, () => {
      browser.write(`GET /left HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`)
      browser.destroy()
    })
    browser.on('error', () => {})

    expect(await waitFor(() => gone.length === 2, 3_000)).toBe(true)
    expect(gone).toEqual(['/left', 'returned'])
  })
})
