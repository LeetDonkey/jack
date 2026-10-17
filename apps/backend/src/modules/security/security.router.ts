import type { BanList } from './ban-list'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

/** Mounted at /security on the management API. */
export function getSecurityRouter(bans: Pick<BanList, 'list' | 'failing' | 'unban'>) {
  const app = new Hono()

  app.get('/bans', describeRoute({
    tags: ['Security'],
    summary: 'Banned and failing addresses',
    description: 'Addresses banned for repeated failed authentication on the public port, and addresses with failures in the current window that are not banned yet.',
    responses: { 200: { description: '`{ bans, failing }`' } },
  }), c => c.json({ bans: bans.list(), failing: bans.failing() }))

  app.delete('/bans/:ip', describeRoute({
    tags: ['Security'],
    summary: 'Lift a ban',
    description: 'Removes the ban and the failure count for one address.',
    responses: { 200: { description: '`{ ok }`: whether a ban was lifted' } },
  }), c => c.json({ ok: bans.unban(decodeURIComponent(c.req.param('ip'))) }))

  return app
}
