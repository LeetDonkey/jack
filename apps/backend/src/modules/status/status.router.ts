import type { StatusController } from './status.controller'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { streamSnapshots } from '../../lib/sse'
import { OverviewSchema } from './status.schema'

export function getStatusRouter(controller: StatusController) {
  const app = new Hono()

  app.get('/overview', describeRoute({
    tags: ['Status'],
    summary: 'Connector overview',
    description: 'Configured servers and peers with their initialization state, and download totals. Each `servers.items[]` entry also has `registration` (what jack registered in that Radarr/Sonarr at its last registration this boot, and whether the *arr\'s Test of jack\'s download client and indexer passed) and `lastContactAt` (when that *arr last authenticated with the key jack gave it, ISO 8601); both are null until known. `system` is `{ bootedAt, restartPending }`: when this jack started, and the settings saved since then that only apply after a restart of the jack container (`downloads`, `downloads.completedPath`, `downloads.retries`, `jack.tmdbApiKey`, `jack.apiKey`).',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Overview of servers and peers', content: { 'application/json': { schema: resolver(OverviewSchema) } } } },
  }), c => c.json(controller.getOverview()))
  app.get('/overview/stream', describeRoute({
    tags: ['Status'],
    summary: 'Stream connector overview',
    description: 'Server-Sent Events stream with an initial overview snapshot and immediate updates when connector, download or registration state changes, and after every config save.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live overview snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => controller.getOverview(), subscriber => controller.subscribeOverview(subscriber)))
  app.get('/downloads', describeRoute({
    tags: ['Status'],
    summary: 'List downloads',
    description: 'All download records, in-flight and finished.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Download records', content: { 'application/json': {} } } },
  }), c => c.json(controller.listDownloads()))
  app.get('/downloads/stream', describeRoute({
    tags: ['Status'],
    summary: 'Stream downloads',
    description: 'Server-Sent Events stream with an initial download snapshot and immediate updates after every persisted download change.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live download snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => controller.listDownloads(), subscriber => controller.subscribeDownloads(subscriber)))

  return app
}
