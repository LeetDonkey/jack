import type { NotificationsService } from './notifications.service'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

export function getNotificationsRouter(notifications: Pick<NotificationsService, 'send'>) {
  const app = new Hono()
  app.post('/test', describeRoute({
    tags: ['Notifications'],
    summary: 'Send a test notification',
    description: 'Sends a test message to every configured webhook and reports how many accepted it.',
    responses: { 200: { description: '`{ delivered }`: the number of webhooks that answered 2xx' } },
  }), async (c) => {
    const delivered = await notifications.send({ event: 'test', title: 'jack test notification', message: 'Notifications from jack reach this channel.' })
    return c.json({ delivered })
  })
  return app
}
