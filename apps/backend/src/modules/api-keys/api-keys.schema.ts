import z from 'zod'
import { API_KEY_ORIGINS } from './api-key-meta'

export const CreateApiKeyBody = z.object({
  name: z.string().max(100).nullish(),
  description: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
})

export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBody>

export const UpdateApiKeyBody = z.object({
  name: z.string().max(100).nullish(),
  description: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
  /** Link the key to a configured peer (the same friend), or `null` to unlink it. */
  peerId: z.string().min(1).max(64).nullish(),
})

export type UpdateApiKeyBody = z.infer<typeof UpdateApiKeyBody>

// Response shapes, for the OpenAPI docs (see ApiKeyResponse in api-keys.controller.ts).

export const ApiKeyResponseSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable().describe('When a friend\'s jack last authenticated with the key (ISO 8601, to the minute); null when not since `lastUsedTrackedSince`'),
  lastUsedTrackedSince: z.string().describe('When `lastUsedAt` starts to count: `createdAt`, or for a key made before jack recorded last use, the start of that'),
  peerId: z.string().nullable().describe('The peer this key is explicitly linked to (the same friend), or null'),
  origin: z.enum(API_KEY_ORIGINS).nullable().describe('`quick-link` or `introduction` when jack made the key for a friend; null otherwise'),
  boundIdentityId: z.string().nullable().describe('The jack identity that used this key for friends-of-friends mail, or null'),
})

export const CreateApiKeyResponseSchema = ApiKeyResponseSchema.extend({
  key: z.string().describe('The plaintext key. Only this response contains it'),
})
