import z from 'zod'

// An X25519 public key: 32 bytes, base64url without padding.
export const PublicKey = z.string().regex(/^[\w-]{43}$/, 'Expected a base64url X25519 public key')

const PublicName = z.string().trim().min(1).max(60)

/** What a jack tells its direct friends about itself (GET /peer/intro/profile). */
export const IntroProfile = z.object({
  id: z.uuid(),
  name: PublicName.nullable(),
  publicKey: PublicKey,
  discoverable: z.boolean(),
})

export type IntroProfile = z.infer<typeof IntroProfile>

/**
 * A friend's list of *its* friends who opted in to be found (GET /peer/intro/directory).
 * Names and keys only: no URL, address or anything else that locates them.
 */
export const IntroDirectory = z.object({
  introducer: z.object({ id: z.uuid(), name: PublicName.nullable() }),
  people: z.array(z.object({ id: z.uuid(), name: PublicName, publicKey: PublicKey })).max(500),
})

export type IntroDirectory = z.infer<typeof IntroDirectory>

export const ENVELOPE_TYPES = ['request', 'response', 'card', 'message'] as const

/**
 * One end-to-end encrypted message between two jacks, carried by the friend they
 * have in common (`via`). The carrier sees who talks to whom (it is friends with
 * both) but not what: the payload is AES-256-GCM under a key only `from` and `to`
 * can derive, and the header fields are bound to it as associated data.
 */
export const IntroEnvelope = z.object({
  v: z.literal(1),
  id: z.uuid(),
  type: z.enum(ENVELOPE_TYPES),
  requestId: z.uuid(),
  from: z.uuid(),
  fromName: PublicName,
  fromKey: PublicKey,
  to: z.uuid(),
  via: z.uuid(),
  createdAt: z.string().max(40),
  nonce: z.string().max(32),
  ciphertext: z.string().max(32_768),
})

export type IntroEnvelope = z.infer<typeof IntroEnvelope>

/** POST /peer/intro/mail: the caller hands over mail for (or through) the callee and gets mail back. */
export const IntroMailRequest = z.object({
  self: z.object({ id: z.uuid(), publicKey: PublicKey }),
  messages: z.array(IntroEnvelope).max(100),
})

export type IntroMailRequest = z.infer<typeof IntroMailRequest>

// Each returned envelope is validated on its own, so one bad entry can't hide the rest.
export const IntroMailResponse = z.object({ messages: z.array(z.unknown()).max(100) })

/** Decrypted payloads, per envelope type. */
export const RequestPayload = z.object({ message: z.string().max(2000).optional() })
export const ResponsePayload = z.object({ accepted: z.boolean(), message: z.string().max(2000).optional() })
export const CardPayload = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
  apiKey: z.string().min(1).max(500),
})
export const MessagePayload = z.object({ text: z.string().min(1).max(2000) })

export type CardPayload = z.infer<typeof CardPayload>
