import type { ZodType } from 'zod'
import type { ApiKeysController } from './api-keys.controller'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import z from 'zod'
import { validator as zValidator } from '../../lib/validation'
import { ApiKeyResponseSchema, CreateApiKeyBody, CreateApiKeyResponseSchema, UpdateApiKeyBody } from './api-keys.schema'

const idParam = z.object({
  id: z.coerce.number().int().positive(),
})

const KEY_FIELDS_DOC = 'Each key also has `lastUsedAt` (when a friend\'s jack last authenticated with it, to the minute; null when not since `lastUsedTrackedSince`), `lastUsedTrackedSince` (the key\'s creation, or for a key made before jack recorded last use, the start of that), `peerId` (the peer it is explicitly linked to as the same friend, or null), `origin` (`quick-link` or `introduction` when jack made it for a friend, else null) and `boundIdentityId` (the jack identity that used it for friends-of-friends mail, or null).'

const NOT_FOUND = { 404: { description: 'No API key with that id' } }

function apiKeysDoc(summary: string, description: string | undefined, success: { status?: number, schema: ZodType }, errors: Record<number, { description: string }> = {}) {
  return describeRoute({
    tags: ['API keys'],
    summary,
    description,
    security: [{ 'X-Management-Key': [] }],
    responses: {
      [success.status ?? 200]: { description: 'Success', content: { 'application/json': { schema: resolver(success.schema) } } },
      ...errors,
    },
  })
}

export function getApiKeysRouter(controller: ApiKeysController) {
  const app = new Hono()

  app.post('/', apiKeysDoc('Create a peer API key', `Issues a named, revocable, optionally expiring key. The plaintext key is only returned by this call. ${KEY_FIELDS_DOC}`, { status: 201, schema: CreateApiKeyResponseSchema }, { 400: { description: 'The body failed validation' } }), zValidator('json', CreateApiKeyBody), (c) => {
    const body = c.req.valid('json')
    const result = controller.create(body)
    return c.json(result, 201)
  })

  app.get('/', apiKeysDoc('List peer API keys', KEY_FIELDS_DOC, { schema: z.array(ApiKeyResponseSchema) }), (c) => {
    const result = controller.list()
    return c.json(result)
  })

  app.get('/:id', apiKeysDoc('Get a peer API key', KEY_FIELDS_DOC, { schema: ApiKeyResponseSchema }, NOT_FOUND), zValidator('param', idParam), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.get(id)
    return c.json(result)
  })

  app.patch('/:id', apiKeysDoc('Update a peer API key', `Changes the given fields. \`peerId\` links the key to a configured peer, so the friends view shows both as one friend; \`null\` unlinks it. ${KEY_FIELDS_DOC}`, { schema: ApiKeyResponseSchema }, {
    400: { description: 'The body failed validation, or `peerId` names no configured peer (`error.field` is `peerId`)' },
    ...NOT_FOUND,
  }), zValidator('param', idParam), zValidator('json', UpdateApiKeyBody), (c) => {
    const { id } = c.req.valid('param')
    const body = c.req.valid('json')
    const result = controller.update(id, body)
    return c.json(result)
  })

  app.delete('/:id', apiKeysDoc('Revoke a peer API key', 'Deletes the key, its link to a peer, its last-used time and its friends-of-friends identity binding. A jack still using it gets 401 from then on.', { schema: z.object({ ok: z.literal(true) }) }, NOT_FOUND), zValidator('param', idParam), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.delete(id)
    return c.json(result)
  })

  return app
}
