import type { TransfersService } from './transfers.service'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { streamSnapshots } from '../../lib/sse'

export function getTransfersRouter(service: TransfersService) {
  const app = new Hono()

  app.get('/', describeRoute({
    tags: ['Transfers'],
    summary: 'Active transfers',
    description: 'In-flight peer downloads and uploads with speed and ETA, combined speed per direction, and the limits in force.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Transfer snapshot', content: { 'application/json': {} } } },
  }), c => c.json(service.snapshot()))

  app.get('/stream', describeRoute({
    tags: ['Transfers'],
    summary: 'Stream active transfers',
    description: 'Server-Sent Events stream: an initial snapshot, then one every second while transfers are active and on every start or end.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live transfer snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => service.snapshot(), subscriber => service.subscribe(subscriber)))

  return app
}
