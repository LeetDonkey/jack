import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { handleError } from '../middleware/handle-error'
import { ValidationError, validator } from './validation'

const Body = z.object({
  url: z.url(),
  schedule: z.array(z.object({ days: z.array(z.number()).min(1) })),
})

function app() {
  const app = new Hono()
  app.post('/routed', validator('json', Body), c => c.json({ ok: true, url: c.req.valid('json').url }))
  app.post('/thrown', async (c) => {
    const parsed = Body.safeParse(await c.req.json())
    if (!parsed.success)
      throw ValidationError.fromZod(parsed.error)
    return c.json({ ok: true })
  })
  app.onError(handleError('test', { exposeDetails: true }))
  return app
}

function post(path: string, body: unknown) {
  return app().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

describe('management validation errors', () => {
  const bad = { url: '192.168.0.20:7878', schedule: [{ days: [1] }, { days: [] }], apiKey: 'secret-value-123456' }

  test('the route validator answers 400 with the first issue as message and field, and every issue', async () => {
    const res = await post('/routed', bad)
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'url: Invalid URL',
        field: 'url',
        issues: [
          { field: 'url', message: 'Invalid URL' },
          { field: 'schedule.1.days', message: expect.stringContaining('>=1') },
        ],
      },
    })
    // The library's default body echoed the submitted data back.
    expect(JSON.stringify(body)).not.toContain('secret-value')
  })

  test('a ValidationError thrown in a handler answers with the same body', async () => {
    const routed = await (await post('/routed', bad)).json()
    const res = await post('/thrown', bad)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(routed)
  })

  test('an issue about the body as a whole has no field', async () => {
    const res = await app().request('/routed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' })
    const body = await res.json() as any
    expect(body.error.field).toBeNull()
    expect(body.error.message).toBe(body.error.issues[0].message)
  })

  test('a valid body passes through', async () => {
    const res = await post('/routed', { url: 'http://192.168.0.20:7878', schedule: [] })
    expect(await res.json()).toEqual({ ok: true, url: 'http://192.168.0.20:7878' })
  })

  test('forField builds a single-field error', () => {
    const error = ValidationError.forField('peerId', 'No peer with id "x"')
    expect(error.message).toBe('peerId: No peer with id "x"')
    expect(error.field).toBe('peerId')
    expect(error.code).toBe('VALIDATION_ERROR')
  })
})
