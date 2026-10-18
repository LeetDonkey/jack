import type { CatalogController } from './catalog.controller'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { z } from 'zod'
import { validator as zValidator } from '../../lib/validation'

const tmdbParam = z.object({
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.coerce.number().int(),
})

const requestBody = z.object({
  peerId: z.string().min(1),
  serverId: z.string().min(1),
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  rootFolderPath: z.string().min(1),
})

function catalogDoc(summary: string, description?: string) {
  return describeRoute({
    tags: ['Catalog'],
    summary,
    description,
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Success', content: { 'application/json': {} } } },
  })
}

export function getCatalogRouter(controller: CatalogController) {
  const app = new Hono()

  // Register the static path before any future dynamic segment.
  app.get('/tmdb/status', catalogDoc('TMDB integration status', 'Whether a TMDB API key is configured, so the UI knows if metadata lookups are available.'), async c => c.json(await controller.getTmdbStatus()))

  // Per-title TMDB lookup the catalog grid calls once per visible card.
  app.get('/tmdb/:mediaType/:tmdbId', catalogDoc('Get TMDB title metadata', 'Per-title lookup the catalog grid calls once per visible card.'), zValidator('param', tmdbParam), async (c) => {
    const { mediaType, tmdbId } = c.req.valid('param')
    return c.json(await controller.getTitleMetadata(mediaType, tmdbId))
  })

  app.get('/request-options', catalogDoc('List request targets', 'Destination servers (with root folders) a catalog item can be requested into, as `servers`. A destination that is down or can\'t list its root folders is left out. `downloadsActive` says whether a request can start downloads now; when it can\'t, `downloadsInactiveReason` says why: `off` (downloads aren\'t set up) or `restartPending` (they were set up after jack started, and start with the next restart of the jack container).'), async (c) => {
    const reason = controller.downloadsInactiveReason()
    return c.json({ servers: await controller.getRequestOptions(), downloadsActive: reason === null, downloadsInactiveReason: reason })
  })

  app.post('/request', catalogDoc('Request a download', 'Grabs a peer\'s catalog item into one of the local destination servers.'), zValidator('json', requestBody), async (c) => {
    return c.json(await controller.requestDownload(c.req.valid('json')))
  })

  // Aggregated catalog across all initialized peers.
  app.get('/', catalogDoc('Get the aggregated catalog', 'Everything available across all initialized peers. Each peer catalog is cached for 15 minutes; `?refresh=true` asks the peers again. `peers` lists the peers in the answer, each `{ id, name, online, fetchedAt, ageSeconds, stale }`: `online` is the last health check (null before the first), `fetchedAt` and `ageSeconds` say how old its catalog is, and `stale` is true when jack just failed to fetch a newer one and shows the cached one. `unavailable` lists configured peers with nothing in the answer, each `{ id, name, online, error }`. Each title has `addedAt`: when its newest release was added at the peer (ISO 8601), or null.'), async c => c.json(await controller.getCatalog({ refresh: c.req.query('refresh') === 'true' })))

  return app
}
