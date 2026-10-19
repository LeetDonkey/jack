import type { AddressInfo } from 'node:net'
import { describe, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { Hono } from 'hono'
import { asksToClose, startPublicServer } from '../lib/public-server'

describe('startPublicServer', () => {
  test('leaves the global Request/Response alone so Bun.serve keeps working in-process', async () => {
    const NativeResponse = globalThis.Response
    const NativeRequest = globalThis.Request
    const publicApp = new Hono().get('/ping', c => c.json({ from: 'public' }))
    const server = startPublicServer(publicApp.fetch, 0)
    await new Promise<void>(resolve => server.once('listening', () => resolve()))

    // The management API runs on Bun.serve next to the public server.
    const management = Bun.serve({ port: 0, fetch: new Hono().get('/ping', c => c.json({ from: 'management' })).fetch })
    try {
      expect(globalThis.Response).toBe(NativeResponse)
      expect(globalThis.Request).toBe(NativeRequest)

      const { port } = server.address() as AddressInfo
      expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).json()).toEqual({ from: 'public' })

      const res = await fetch(`http://127.0.0.1:${management.port}/ping`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ from: 'management' })
    }
    finally {
      server.close()
      management.stop(true)
    }
  })

  // Radarr sends `Connection: close` on qBittorrent calls and, unless the answer
  // says so too, sends its next request (the login after a 403) on that socket.
  test('answers Connection: close when the request asks for it, and only then', async () => {
    const server = startPublicServer(new Hono().get('*', c => c.text('Forbidden', 403)).fetch, 0)
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    // The response head, read from a raw socket so nothing adds or drops headers.
    const head = (connection: string | null) => new Promise<string>((resolve, reject) => {
      let data = ''
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET /api/v2/app/webapiVersion HTTP/1.1\r\nHost: jack\r\n${connection ? `Connection: ${connection}\r\n` : ''}\r\n`)
      })
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(data)
      }, 2000)
      socket.on('data', (chunk) => {
        data += chunk.toString()
        if (data.includes('\r\n\r\n')) {
          clearTimeout(timer)
          socket.destroy()
          resolve(data.split('\r\n\r\n')[0]!.toLowerCase())
        }
      })
      socket.on('error', reject)
    })
    try {
      expect(await head('close')).toContain('connection: close')
      expect(await head('Keep-Alive, Close')).toContain('connection: close')
      expect(await head(null)).not.toContain('connection: close')
      expect(await head('keep-alive')).not.toContain('connection: close')
    }
    finally {
      server.close()
    }
  })

  test('asksToClose reads the Connection tokens', () => {
    expect(asksToClose({ headers: { connection: 'close' } })).toBe(true)
    expect(asksToClose({ headers: { connection: 'keep-alive, Close' } })).toBe(true)
    expect(asksToClose({ headers: { connection: 'keep-alive' } })).toBe(false)
    expect(asksToClose({ headers: {} })).toBe(false)
  })
})
