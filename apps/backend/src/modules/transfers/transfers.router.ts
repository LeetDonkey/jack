import type { TransferPauses } from './transfer-pauses'
import type { TransfersService } from './transfers.service'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { z } from 'zod'
import { PausedUntil } from '../../lib/config'
import { streamSnapshots } from '../../lib/sse'
import { toValidationIssues, validationErrorBody, validator as zValidator } from '../../lib/validation'
import { PAUSE_TARGETS } from './pause'

const PauseStateSchema = z.object({
  paused: z.boolean(),
  until: z.string().nullable().describe('When it resumes by itself (ISO 8601); null when not paused or paused until resumed'),
  indefinite: z.boolean().describe('Paused until someone resumes it'),
})

const PausesSchema = z.object({ uploads: PauseStateSchema, downloads: PauseStateSchema })

const PausesAnswerSchema = z.object({ ok: z.literal(true), paused: PausesSchema })

const PauseBody = z.object({
  what: z.enum(PAUSE_TARGETS).describe('`uploads` pauses sharing (friends downloading from you); `downloads` pauses downloading from friends'),
  until: PausedUntil.describe('When to resume: an ISO 8601 time with a UTC offset, in the future, or `indefinite` to stay paused until resumed'),
})

const ResumeBody = z.object({
  what: z.enum(PAUSE_TARGETS).optional().describe('What to resume; both when absent'),
})

const PAUSE_DOC = 'Pausing `uploads` answers friends\' file requests with 503 "Sharing is paused" and `Retry-After` (the seconds until the pause ends, at most 60). Uploads already running finish, including the following 64 MiB Range windows of a friend\'s jack that fetches a large file in parts. Pausing `downloads` stops downloads from taking a slot: running transfers finish, the rest wait as `queued`. A friend\'s jack keeps retrying a paused upload for about 24 hours (its `downloads.retryWindowMs`), then gives up. The pause is saved as `bandwidth.pausedUntil` or `downloads.pausedUntil`, survives a restart, and ends by itself at `until`.'

export function getTransfersRouter(service: TransfersService, pauses?: TransferPauses) {
  const app = new Hono()

  app.get('/', describeRoute({
    tags: ['Transfers'],
    summary: 'Active transfers',
    description: 'In-flight peer downloads and uploads with speed and ETA, combined speed per direction, the limits in force, and `paused` `{ uploads, downloads }`, each `{ paused, until, indefinite }`. Each transfer has `downloadId`: the download row it belongs to (see `GET /downloads`), or null for an upload.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Transfer snapshot', content: { 'application/json': {} } } },
  }), c => c.json(service.snapshot()))

  app.get('/stream', describeRoute({
    tags: ['Transfers'],
    summary: 'Stream active transfers',
    description: 'Server-Sent Events stream: an initial snapshot, then one every second while transfers are active, on every start or end, and when a pause starts or ends.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live transfer snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => service.snapshot(), subscriber => service.subscribe(subscriber)))

  if (pauses) {
    app.post('/pause', describeRoute({
      tags: ['Transfers'],
      summary: 'Pause sharing or downloads',
      description: `${PAUSE_DOC} Pausing again replaces the earlier time.`,
      security: [{ 'X-Management-Key': [] }],
      responses: {
        200: { description: 'Both pauses after the change', content: { 'application/json': { schema: resolver(PausesAnswerSchema) } } },
        400: { description: 'The body fails validation, or `until` is in the past (`error.field` is `until`)' },
        409: { description: 'Downloads are off, so there is nothing to pause' },
      },
    }), zValidator('json', PauseBody), async (c) => {
      const { what, until } = c.req.valid('json')
      return c.json(await pauses.pause(what, until))
    })

    app.post('/resume', describeRoute({
      tags: ['Transfers'],
      summary: 'Resume sharing or downloads',
      description: 'Ends a pause now. The body `{ what }` is optional; without it both directions resume.',
      security: [{ 'X-Management-Key': [] }],
      responses: {
        200: { description: 'Both pauses after the change', content: { 'application/json': { schema: resolver(PausesAnswerSchema) } } },
        400: { description: '`what` is neither `uploads` nor `downloads`' },
      },
    }), async (c) => {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = ResumeBody.safeParse(raw ?? {})
      if (!parsed.success)
        return c.json(validationErrorBody(toValidationIssues(parsed.error.issues)), 400)
      return c.json(await pauses.resume(parsed.data.what))
    })
  }

  return app
}
