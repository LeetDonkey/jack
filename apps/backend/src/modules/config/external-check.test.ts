import { describe, expect, test } from 'bun:test'
import { ConfigController } from './config.controller'
import { checkExternalUrl } from './external-check'

function fetchAnswering(response: () => Response | Promise<Response>, seen: Array<{ url: string, headers: unknown }> = []) {
  return async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers })
    return response()
  }
}

describe('checkExternalUrl', () => {
  test('passes when jack answers /ping there, sending the external headers', async () => {
    const seen: Array<{ url: string, headers: unknown }> = []
    const result = await checkExternalUrl(
      { url: 'https://jack.example.com/some/path', headers: { 'CF-Access-Client-Id': 'id' } },
      { fetch: fetchAnswering(() => Response.json({ status: 'OK' }), seen) },
    )
    expect(result).toEqual({ ok: true, status: 200, error: null, url: 'https://jack.example.com/ping' })
    expect(seen).toEqual([{ url: 'https://jack.example.com/ping', headers: { 'CF-Access-Client-Id': 'id' } }])
  })

  test('explains an HTTP answer that isn\'t jack\'s', async () => {
    const check = (response: () => Response) => checkExternalUrl({ url: 'https://jack.example.com' }, { fetch: fetchAnswering(response) })

    expect(await check(() => new Response('nope', { status: 403 }))).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('headers') })
    expect(await check(() => new Response('', { status: 404 }))).toMatchObject({ ok: false, status: 404, error: expect.stringContaining('port 5225') })
    expect(await check(() => new Response('', { status: 502 }))).toMatchObject({ ok: false, status: 502, error: expect.stringContaining('may not reach jack') })
    expect(await check(() => new Response('<html>router login</html>', { status: 200 }))).toMatchObject({ ok: false, status: 200, error: expect.stringContaining('not as jack') })
  })

  test('explains when nothing answers', async () => {
    const timeout = await checkExternalUrl({ url: 'https://jack.example.com' }, {
      timeoutMs: 10_000,
      fetch: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
    })
    expect(timeout).toEqual({ ok: false, status: null, error: 'No answer within 10 seconds.', url: 'https://jack.example.com/ping' })

    const dns = await checkExternalUrl({ url: 'https://nowhere.invalid' }, {
      fetch: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
      },
    })
    expect(dns.error).toContain('doesn\'t resolve')
  })
})

describe('ConfigController.testExternal', () => {
  const saved = { url: 'https://saved.example.com', headers: {} }
  const controller = (external: typeof saved | null) => new ConfigController(
    { servers: [], peers: [] },
    { getResolvedExternalJack: () => external } as any,
    undefined,
    { externalCheck: { fetch: async url => Response.json({ status: url.startsWith('https://saved') ? 'OK' : 'nope' }) } },
  )

  test('checks the saved address, or the one in the body', async () => {
    expect(await controller(saved).testExternal(null)).toMatchObject({ ok: true, url: 'https://saved.example.com/ping' })
    expect(await controller(saved).testExternal({ url: 'https://draft.example.com', headers: { 'X-Token': 'a' } })).toMatchObject({ ok: false, url: 'https://draft.example.com/ping' })
  })

  test('without a saved address or a url in the body it is a 400 on url', async () => {
    await expect(controller(null).testExternal({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'url' })
    await expect(controller(null).testExternal({ url: 'ftp://x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'url' })
  })
})
