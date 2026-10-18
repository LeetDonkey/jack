import { z } from 'zod'
import { ServerType } from '../../lib/config'
import { ServerRegistrationFieldsSchema } from '../registration/registration.schema'

// Response shapes of the config list routes, for the OpenAPI docs.

const ConnectorFields = z.object({
  id: z.string().describe('Derived from the URL; edit and delete routes take it'),
  name: z.string(),
  url: z.string(),
  initialized: z.boolean(),
  initializationError: z.string().nullable(),
})

// Only present when the management API can rewrite the config file.
const StoredSecrets = z.object({
  apiKey: z.unknown().optional().describe('As stored: a string or an `{env}`/`{file}` reference'),
  headers: z.record(z.string(), z.unknown()).optional().describe('As stored, references intact'),
})

export const ConfigServerSchema = ConnectorFields
  .extend({
    type: ServerType,
    source: z.boolean(),
    destination: z.boolean(),
    autoregister: z.object({ enable: z.boolean(), priority: z.number() }).describe('With defaults applied'),
    upgrades: z.object({ allow: z.boolean(), maxSizeGiB: z.number().nullable() }),
  })
  .extend(ServerRegistrationFieldsSchema.shape)
  .extend(StoredSecrets.shape)

export const ConfigPeerSchema = ConnectorFields
  .extend({
    type: z.literal('jack'),
    version: z.string().nullable().describe('The friend\'s protocol version, once known'),
  })
  .extend(StoredSecrets.shape)

export const ConfigListSchema = z.object({
  servers: z.array(ConfigServerSchema),
  peers: z.array(ConfigPeerSchema),
})

export const ServerListSchema = z.object({ servers: z.array(ConfigServerSchema) })
