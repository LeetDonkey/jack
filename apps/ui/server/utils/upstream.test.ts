import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { fetchUpstream, hostResolves, jackAnswers, JackSilentError, probeJack } from './upstream'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

// A fake jack on a raw socket. `respond` gets each request's first bytes and
// decides whether, when and how to answer; a socket it never writes to is a
// call that hangs before the headers.
async function fakeJack(respond: (socket: Socket, request: string) => void) {
  const open = new Set<Socket>()
  const server = createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
    socket.once('data', data => respond(socket, data.toString()))
  })
  server.listen(0, '127.0.0.1')
  for (let i = 0; i < 50 && !server.address(); i++)
    await Bun.sleep(10)
  cleanups.push(() => {
    for (const socket of open)
      socket.destroy()
    server.close()
  })
  const { port } = server.address() as AddressInfo
  return { port, url: (path: string) => `http://127.0.0.1:${port}${path}` }
}

function answer(socket: Socket, status: number, body = '{}') {
  socket.end(`HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`)
}

// A port nothing listens on: taken and released again.
async function closedPort(): Promise<number> {
  const jack = await fakeJack(() => {})
  cleanups.pop()!()
  return jack.port
}

const neverResolves = () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
const alwaysResolves = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }])

// A fetch that never gets an answer: the connect to a stopped container's old
// address. It only ends when the signal aborts.
const hangingFetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
})) as typeof fetch

describe('probeJack', () => {
  test('reports the status jack answers with, and sends the key', async () => {
    let request = ''
    const jack = await fakeJack((socket, text) => {
      request = text
      answer(socket, 401)
    })
    expect(await probeJack(jack.url('/ping'), 'k3y', { lookupHost: neverResolves })).toEqual({ reachable: true, status: 401 })
    expect(request.toLowerCase()).toContain('x-management-key: k3y')
  })

  // The stale-lookup bug: a long-running Bun process kept failing the lookup for
  // minutes after jack was back, and the probe never got to the request.
  test('a jack that answers is reachable even while the lookup fails', async () => {
    const jack = await fakeJack(socket => answer(socket, 200))
    const url = `http://localhost:${jack.port}/ping`
    expect(await probeJack(url, null, { lookupHost: neverResolves })).toEqual({ reachable: true, status: 200 })
  })

  test('a name that doesn\'t resolve is dns', async () => {
    const result = await probeJack('http://jack:5226/ping', null, {
      lookupHost: neverResolves,
      fetch: (() => Promise.reject(Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' }))) as unknown as typeof fetch,
    })
    expect(result).toEqual({ reachable: false, reason: 'dns' })
  })

  test('a closed port is down', async () => {
    const port = await closedPort()
    expect(await probeJack(`http://127.0.0.1:${port}/ping`, null)).toEqual({ reachable: false, reason: 'down' })
  })

  test('a name that resolves with nothing behind it is down', async () => {
    const port = await closedPort()
    expect(await probeJack(`http://localhost:${port}/ping`, null, { lookupHost: alwaysResolves })).toEqual({ reachable: false, reason: 'down' })
  })

  test('no answer within the timeout is timeout', async () => {
    const jack = await fakeJack(() => {})
    const started = Date.now()
    expect(await probeJack(jack.url('/ping'), null, { timeoutMs: 200 })).toEqual({ reachable: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('a hang on an address whose name is gone is dns, once the grace is up', async () => {
    const started = Date.now()
    const result = await probeJack('http://jack:5226/ping', null, { timeoutMs: 5_000, dnsGraceMs: 100, lookupHost: neverResolves, fetch: hangingFetch })
    expect(result).toEqual({ reachable: false, reason: 'dns' })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('the grace leaves time for a jack that answers', async () => {
    const jack = await fakeJack(socket => setTimeout(answer, 50, socket, 200))
    const result = await probeJack(`http://localhost:${jack.port}/ping`, null, { dnsGraceMs: 500, lookupHost: neverResolves })
    expect(result).toEqual({ reachable: true, status: 200 })
  })
})

describe('hostResolves', () => {
  test('takes IP literals as they are', async () => {
    const signal = new AbortController().signal
    expect(await hostResolves('127.0.0.1', signal, neverResolves)).toBe(true)
    expect(await hostResolves('[::1]', signal, neverResolves)).toBe(true)
  })

  test('reports the lookup, or null when it doesn\'t settle in time', async () => {
    const signal = new AbortController().signal
    expect(await hostResolves('jack', signal, alwaysResolves)).toBe(true)
    expect(await hostResolves('jack', signal, neverResolves)).toBe(false)
    expect(await hostResolves('jack', AbortSignal.timeout(50), () => new Promise(() => {}))).toBeNull()
  })

  test('asks the system resolver', async () => {
    const signal = AbortSignal.timeout(5_000)
    expect(await hostResolves('localhost', signal)).toBe(true)
    expect(await hostResolves('no-such-host.invalid', signal)).toBe(false)
  })
})

describe('jackAnswers', () => {
  test('any status counts, and no answer doesn\'t', async () => {
    const jack = await fakeJack(socket => answer(socket, 401))
    expect(await jackAnswers(jack.url('/ping'), 'k')).toBe(true)
    const silent = await fakeJack(() => {})
    expect(await jackAnswers(silent.url('/ping'), 'k', 100)).toBe(false)
  })

  test('calls on their way at the same time share one request', async () => {
    let requests = 0
    const jack = await fakeJack((socket) => {
      requests++
      setTimeout(answer, 50, socket, 200)
    })
    const url = jack.url('/ping')
    expect(await Promise.all([jackAnswers(url, null), jackAnswers(url, null), jackAnswers(url, null)])).toEqual([true, true, true])
    expect(requests).toBe(1)
    expect(await jackAnswers(url, null)).toBe(true)
    expect(requests).toBe(2)
  })
})

describe('fetchUpstream', () => {
  const quick = { checkAfterMs: 100, checkEveryMs: 100, streamHeadersMs: 200 }

  test('fails with JackSilentError when a call hangs and jack doesn\'t answer /ping', async () => {
    const jack = await fakeJack(() => {})
    const started = Date.now()
    const call = fetchUpstream(jack.url('/overview'), {}, { ...quick, signal: new AbortController().signal, stream: false, isAlive: async () => false })
    expect(await call.catch((e: unknown) => e)).toBeInstanceOf(JackSilentError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('waits for a slow answer while jack answers /ping', async () => {
    let checks = 0
    const jack = await fakeJack(socket => setTimeout(answer, 600, socket, 200, '{"saved":true}'))
    const res = await fetchUpstream(jack.url('/config/servers'), { method: 'POST', body: '{}' }, {
      ...quick,
      signal: new AbortController().signal,
      stream: false,
      isAlive: async () => {
        checks++
        return true
      },
    })
    expect(await res.json()).toEqual({ saved: true })
    expect(checks).toBeGreaterThanOrEqual(3)
  })

  test('gives up on a slow call once jack stops answering /ping', async () => {
    const jack = await fakeJack(() => {})
    let alive = true
    setTimeout(() => alive = false, 350)
    const started = Date.now()
    const call = fetchUpstream(jack.url('/friends/check'), {}, { ...quick, signal: new AbortController().signal, stream: false, isAlive: async () => alive })
    expect(await call.catch((e: unknown) => e)).toBeInstanceOf(JackSilentError)
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  })

  test('a stream without headers gives up without asking /ping', async () => {
    const jack = await fakeJack(() => {})
    let checks = 0
    const started = Date.now()
    const call = fetchUpstream(jack.url('/overview/stream'), {}, {
      ...quick,
      signal: new AbortController().signal,
      stream: true,
      isAlive: async () => {
        checks++
        return true
      },
    })
    expect(await call.catch((e: unknown) => e)).toBeInstanceOf(JackSilentError)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(checks).toBe(0)
  })

  test('times nothing once the headers are in: a stream keeps going', async () => {
    const jack = await fakeJack((socket) => {
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n')
      let n = 0
      const tick = setInterval(() => {
        const text = `data: ${n++}\n\n`
        socket.write(`${text.length.toString(16)}\r\n${text}\r\n`)
      }, 100)
      socket.on('close', () => clearInterval(tick))
    })
    const browser = new AbortController()
    const res = await fetchUpstream(jack.url('/overview/stream'), {}, { ...quick, signal: browser.signal, stream: true, isAlive: async () => false })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const until = Date.now() + 800
    while (Date.now() < until) {
      const { done, value } = await reader.read()
      if (done)
        break
      text += decoder.decode(value)
    }
    expect(text).toContain('data: 5')

    // The browser's abort still reaches the body: the reads end.
    browser.abort()
    const ended = (async () => {
      try {
        while (!(await reader.read()).done)
          continue
      }
      catch {
        // A failed read ends the body too.
      }
      return 'ended'
    })()
    expect(await Promise.race([ended, Bun.sleep(1_000).then(() => 'still open')])).toBe('ended')
  })

  test('the browser leaving aborts the call with its own reason', async () => {
    const jack = await fakeJack(() => {})
    const browser = new AbortController()
    setTimeout(() => browser.abort(), 50)
    const call = fetchUpstream(jack.url('/overview'), {}, { ...quick, checkAfterMs: 5_000, signal: browser.signal, stream: false, isAlive: async () => true })
    const error = await call.catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(JackSilentError)
  })
})
