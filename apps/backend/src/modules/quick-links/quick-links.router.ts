import type { QuickLinksController } from './quick-links.controller'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator as zValidator } from '../../lib/validation'
import { CreateQuickLinkBody, CreateQuickLinkResponseSchema } from './quick-links.schema'

export function getQuickLinksRouter(controller: QuickLinksController) {
  const app = new Hono()

  app.post('/', describeRoute({
    tags: ['Quick links'],
    summary: 'Generate a peer quick link',
    description: 'Resolves the configured external access profile, issues a fresh revocable API key, and returns a ready-to-share quick link as `{ link, key, replaced }`. The link contains credentials and is returned only once. The key is recorded as made for a friend (`origin: "quick-link"`). `peerId` links it to that peer (the same friend). `replaceKeyId` names a key this link replaces: the new key inherits its `peerId` when the body has none, and the old key is revoked when it was never used and no jack identity is bound to it. `replaced` is then `{ keyId, revoked, keptBecause, lastUsedAt, lastUsedTrackedSince }`: `revoked: false` means the old key stays until the caller revokes it, and `keptBecause` says why: `used` (it has a `lastUsedAt`), `bound` (a jack identity is bound to it) or `unknown` (it was made before jack recorded last use and hasn\'t been used since, so a jack may still use it). `replaced` is null without `replaceKeyId`.',
    security: [{ 'X-Management-Key': [] }],
    responses: {
      201: { description: 'Quick link generated', content: { 'application/json': { schema: resolver(CreateQuickLinkResponseSchema) } } },
      400: { description: 'External access is not set up, or `peerId` names no configured peer (`error.field` is `peerId`)' },
      404: { description: '`replaceKeyId` names no API key' },
    },
  }), zValidator('json', CreateQuickLinkBody), (c) => {
    const result = controller.create(c.req.valid('json'))
    c.header('Cache-Control', 'no-store')
    return c.json(result, 201)
  })

  return app
}
