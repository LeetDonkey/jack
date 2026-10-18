import { z } from 'zod'
import { ServerType } from '../../lib/config'
import { ServerRegistrationFieldsSchema } from '../registration/registration.schema'
import { RESTART_REASONS } from './restart-pending'

// Response shape of GET /overview, for the OpenAPI docs. Download records are
// left open: they are the download list's rows.

const ConnectorFields = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  initialized: z.boolean(),
  initializationError: z.string().nullable(),
})

export const SystemStatusSchema = z.object({
  bootedAt: z.string().describe('When this jack process started (ISO 8601). A new value means jack restarted'),
  restartPending: z.array(z.enum(RESTART_REASONS)).describe('Settings saved since boot that apply only after a restart of the jack container'),
})

const DownloadRow = z.record(z.string(), z.unknown())

export const OverviewSchema = z.object({
  peers: z.object({
    total: z.number(),
    initialized: z.number(),
    items: z.array(ConnectorFields.extend({ type: z.literal('jack'), version: z.string().nullable() })),
  }),
  servers: z.object({
    total: z.number(),
    initialized: z.number(),
    sources: z.number(),
    destinations: z.number(),
    items: z.array(ConnectorFields
      .extend({ type: ServerType, source: z.boolean(), destination: z.boolean() })
      .extend(ServerRegistrationFieldsSchema.shape)),
  }),
  system: SystemStatusSchema,
  downloads: z.object({
    total: z.number(),
    byStatus: z.record(z.string(), z.number()),
    bytesMoved: z.number(),
    mismatched: z.number(),
    active: z.array(DownloadRow),
    importQueued: z.array(DownloadRow),
    failed: z.array(DownloadRow),
  }),
})
