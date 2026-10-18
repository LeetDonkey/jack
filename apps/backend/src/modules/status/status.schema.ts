import { z } from 'zod'
import { ServerType } from '../../lib/config'
import { PEER_ERROR_CODES } from '../../lib/net/peer-errors'
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

export const BuildIdentitySchema = z.object({
  revision: z.string().nullable().describe('Git commit the image was built from'),
  buildDate: z.string().nullable().describe('When the image was built (ISO 8601)'),
})

export const PeerHealthSchema = z.object({
  online: z.boolean().nullable().describe('Whether the last health check (every 5 minutes, and right after the peer is saved) passed; null before the first check'),
  offlineSince: z.string().nullable().describe('When the checks started failing (ISO 8601); null while online'),
  lastSeenAt: z.string().nullable().describe('When a check last passed (ISO 8601)'),
  lastError: z.string().nullable().describe('The last failed check\'s error message; null while online'),
  lastErrorCode: z.enum(PEER_ERROR_CODES).nullable().describe('Why the last check failed; null while online'),
  checkedAt: z.string().nullable().describe('When the last check ran (ISO 8601)'),
})

export const OverviewSchema = z.object({
  peers: z.object({
    total: z.number(),
    initialized: z.number().describe('Peers whose connector connected since boot (it does not notice a peer that went down later; use `online`)'),
    online: z.number().describe('Peers whose last health check passed'),
    items: z.array(ConnectorFields.extend({
      type: z.literal('jack'),
      version: z.string().nullable(),
      build: BuildIdentitySchema.nullable().describe('The build the peer reported in its last handshake; null when it reports none (an older jack, or not checked yet)'),
      health: PeerHealthSchema,
    })),
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
    byStatus: z.record(z.string(), z.number()).describe('Rows per status. A download the user cancelled is not counted as `failed`; see `cancelled`'),
    cancelled: z.number().describe('Rows the user cancelled (stored as `failed`, with `cancelledByUser: true`)'),
    byPhase: z.object({
      queued: z.number(),
      transferring: z.number(),
      retry_wait: z.number(),
    }).describe('Running downloads per phase: waiting for a slot, transferring, waiting to retry'),
    bytesMoved: z.number(),
    mismatched: z.number(),
    active: z.array(DownloadRow),
    importQueued: z.array(DownloadRow),
    failed: z.array(DownloadRow).describe('Failed rows, without the ones the user cancelled'),
  }),
  lifetime: z.object({
    downloadedBytes: z.number().describe('Bytes downloaded from friends since counting started'),
    uploadedBytes: z.number().describe('Bytes friends downloaded from you since counting started'),
    since: z.string().nullable().describe('The first day counted (YYYY-MM-DD, server time); null before any traffic'),
  }),
})
