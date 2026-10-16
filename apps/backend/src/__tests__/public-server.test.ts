import type { AddressInfo } from 'node:net'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { startPublicServer } from '../lib/public-server'

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
})
