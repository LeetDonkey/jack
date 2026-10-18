import type { RegistrationStep } from '../../lib/autoregister'
import type { DestinationRegistration } from './registration.service'
import { z } from 'zod'

// Response shapes for the OpenAPI docs. Typed against the service's interfaces so
// the docs can't drift from what the routes return.

export const RegistrationStepSchema: z.ZodType<RegistrationStep> = z.object({
  status: z.enum(['ok', 'failed', 'skipped']),
  error: z.string().optional().describe('What the *arr (or the network) reported, on `failed`'),
  reason: z.enum(['downloads-off', 'client-failed']).optional().describe('On `skipped`. `downloads-off`: no downloads block, so jack registered nothing. `client-failed` (indexer only): the download client step failed, so jack left the indexer as it was'),
  disabledUnbound: z.literal(true).optional().describe('Indexer only, with downloads off: jack turned off the Jack indexer an earlier jack added, because it had no download client bound'),
})

const TestStatus = z.enum(['ok', 'failed', 'skipped'])

export const DestinationRegistrationSchema: z.ZodType<DestinationRegistration> = z.object({
  at: z.string().describe('When the registration and its tests finished (ISO 8601)'),
  indexer: RegistrationStepSchema.describe('jack\'s Torznab indexer in the *arr'),
  downloadClient: RegistrationStepSchema.describe('jack\'s qBittorrent download client in the *arr'),
  reason: z.enum(['downloads-off']).optional().describe('Set when both steps were skipped because there is no downloads block'),
  clientTest: TestStatus.describe('The *arr\'s Test of jack\'s download client. `skipped` when the client wasn\'t registered or jack needs a restart to serve it'),
  indexerTest: TestStatus.describe('The *arr\'s Test of jack\'s indexer. "No results" counts as `ok`'),
  message: z.string().nullable().describe('Plain-language text about the first failed test, failed step or skip; null when nothing needs saying'),
  testErrors: z.object({
    downloadClient: z.string().nullable(),
    indexer: z.string().nullable(),
  }).describe('The *arr\'s own text for each failed test'),
})

/** `registration` and `lastContactAt`, as every server entry in the config and the overview carries them. */
export const ServerRegistrationFieldsSchema = z.object({
  registration: DestinationRegistrationSchema.nullable().describe('What jack registered in this server at its last registration this boot, with the *arr\'s test results. Null before the first registration and for a server jack doesn\'t register itself in'),
  lastContactAt: z.string().nullable().describe('When this *arr last authenticated with the key jack gave it (ISO 8601), on Torznab or the qBittorrent API. Null until it happens this boot'),
})

const RegistrationPending = z.boolean().describe('true when the registration took longer than 25 seconds: `registration` is then null, and the result arrives on /config/stream and /overview/stream')

export const ServerSaveResponseSchema = z.object({
  ok: z.literal(true),
  registration: DestinationRegistrationSchema.nullable().describe('null when the server isn\'t an auto-register destination, or while `registrationPending` is true'),
  registrationPending: RegistrationPending,
})

export const RegisterResponseSchema = z.object({
  ok: z.literal(true),
  registration: DestinationRegistrationSchema.nullable().describe('null only while `registrationPending` is true'),
  registrationPending: RegistrationPending,
})
