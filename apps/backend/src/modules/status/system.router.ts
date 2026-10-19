import type { SystemNotices } from './system-notices'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { NotFoundError } from '../../lib/errors/NotFoundError'

/** Mounted at /system on the management API. */
export function getSystemRouter(notices: Pick<SystemNotices, 'dismiss'> | undefined) {
  const app = new Hono()

  app.post('/notices/:id/dismiss', describeRoute({
    tags: ['System'],
    summary: 'Dismiss a notice',
    description: 'Hides a notice from `system.notices` on `GET /overview` for good, also after a restart. `/overview/stream` sends the overview without it. Dismissing a notice again answers 204 too.',
    security: [{ 'X-Management-Key': [] }],
    responses: {
      204: { description: 'Dismissed' },
      404: { description: 'This install never had a notice with this id' },
    },
  }), (c) => {
    if (!notices)
      throw new NotFoundError(`No notice "${c.req.param('id')}"`)
    notices.dismiss(c.req.param('id'))
    return c.body(null, 204)
  })

  return app
}
