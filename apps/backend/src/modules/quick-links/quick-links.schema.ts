import z from 'zod'
import { ApiKeyResponseSchema } from '../api-keys/api-keys.schema'

export const CreateQuickLinkBody = z.object({
  peerName: z.string().trim().min(1).max(100),
  keyName: z.string().trim().min(1).max(100),
  keyDescription: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
  /** The peer the new key belongs to (the friend you also download from). */
  peerId: z.string().min(1).max(64).nullish(),
  /** A key this link replaces ("Send a new link"): revoked when it was never used. */
  replaceKeyId: z.number().int().positive().nullish(),
})

export type CreateQuickLinkBody = z.infer<typeof CreateQuickLinkBody>

// Response shape of POST /quick-links, for the OpenAPI docs.

export const ReplacedKeySchema = z.object({
  keyId: z.number(),
  revoked: z.boolean().describe('True when jack revoked the old key: it was never used and no jack identity is bound to it'),
  keptBecause: z.enum(['used', 'bound', 'unknown']).nullable().describe('Why the old key was kept: `used` (lastUsedAt is set), `bound` (a jack identity is bound to it) or `unknown` (made before jack recorded last use, and not used since `lastUsedTrackedSince`). Null when revoked'),
  lastUsedAt: z.string().nullable(),
  lastUsedTrackedSince: z.string(),
})

export const CreateQuickLinkResponseSchema = z.object({
  link: z.string().describe('The quick link. It contains the new key and is returned only once'),
  key: ApiKeyResponseSchema,
  replaced: ReplacedKeySchema.nullable().describe('What happened to the key named by `replaceKeyId`; null without it'),
})
