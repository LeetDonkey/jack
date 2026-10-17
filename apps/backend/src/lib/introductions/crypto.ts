import type { IntroEnvelope } from './wire'
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'

export interface IdentityKeys {
  /** X25519 public key, base64url. */
  publicKey: string
  /** X25519 private scalar, base64url. */
  privateKey: string
}

const INFO = Buffer.from('jack-intro-v1')
const TAG_BYTES = 16

export function generateIdentityKeys(): IdentityKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const jwk = privateKey.export({ format: 'jwk' })
  return { publicKey: publicKey.export({ format: 'jwk' }).x!, privateKey: jwk.d! }
}

/** The AES-256 key two identities share, derived with X25519 and HKDF-SHA256. */
export function sharedKey(own: IdentityKeys, theirPublicKey: string): Buffer {
  const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: own.privateKey, x: own.publicKey }, format: 'jwk' })
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: theirPublicKey }, format: 'jwk' })
  return Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), Buffer.alloc(0), INFO, 32))
}

type EnvelopeHeader = Pick<IntroEnvelope, 'v' | 'id' | 'type' | 'requestId' | 'from' | 'fromName' | 'fromKey' | 'to' | 'via' | 'createdAt'>

// Every header field is authenticated, so a carrier can't redirect or relabel a message.
function aad(header: EnvelopeHeader): Buffer {
  return Buffer.from([header.v, header.id, header.type, header.requestId, header.from, header.fromName, header.fromKey, header.to, header.via, header.createdAt].join('\n'))
}

export function seal(key: Buffer, header: EnvelopeHeader, payload: unknown): Pick<IntroEnvelope, 'nonce' | 'ciphertext'> {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad(header))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url') }
}

/** Decrypt and parse an envelope's payload. Throws when it was tampered with or isn't for this key. */
export function open(key: Buffer, envelope: IntroEnvelope): unknown {
  const data = Buffer.from(envelope.ciphertext, 'base64url')
  if (data.length < TAG_BYTES)
    throw new Error('Ciphertext too short')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'))
  decipher.setAAD(aad(envelope))
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES))
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

/**
 * A short code both people see for their pair of keys. The friend in between
 * carries the keys, so in principle it could swap them; comparing this code
 * (by phone, say) rules that out.
 */
export function safetyCode(a: string, b: string): string {
  const digest = createHash('sha256').update([a, b].sort().join(':')).digest()
  const digits = (digest.readUIntBE(0, 6) % 1e12).toString().padStart(12, '0')
  return [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8, 12)].join(' ')
}
