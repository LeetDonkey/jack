import type { ApiKeyRow } from '../../database/schema'
import type { ApiKeyMeta, ApiKeyMetaRow, ApiKeyOrigin } from './api-key-meta'
import type { ApiKeysRepository } from './api-keys.repository'
import type { CreateApiKeyBody, UpdateApiKeyBody } from './api-keys.schema'
import { generateApiKey, hashKey } from '../../lib/crypto'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { ValidationError } from '../../lib/validation'
import { lastUsedTrackedSince } from './api-key-meta'

export interface ApiKeyResponse {
  id: number
  name: string | null
  description: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  /** When a friend's jack last authenticated with the key (to the minute), or null when not since `lastUsedTrackedSince`. */
  lastUsedAt: string | null
  /**
   * When `lastUsedAt` starts to count: `createdAt`, or for a key made before jack
   * recorded last use, the start of that. A null `lastUsedAt` means "not used since then".
   */
  lastUsedTrackedSince: string
  /** The peer this key is explicitly linked to (the same friend), or null. */
  peerId: string | null
  /** `quick-link` or `introduction` when jack made the key for a friend; null otherwise. */
  origin: ApiKeyOrigin | null
  /** The jack identity that used this key for friends-of-friends mail (fork jacks do within a minute), or null. */
  boundIdentityId: string | null
}

export interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string
}

/** A key's identity binding from introductions (intro_bindings). */
export interface KeyBinding {
  apiKeyId: number
  identityId: string
  boundAt: string
}

export interface ApiKeysControllerDeps {
  meta?: Pick<ApiKeyMeta, 'get' | 'all' | 'setPeer' | 'setOrigin' | 'delete' | 'trackingSince'>
  /** Identity bindings; a revoked key's binding is deleted with it. */
  bindings?: { keyBindings: () => KeyBinding[], forgetKey: (apiKeyId: number) => void }
  /** Whether a peer with this id is configured (to validate `peerId`). */
  peerExists?: (peerId: string) => boolean
}

const NO_META = { peerId: null, origin: null, lastUsedAt: null }

export class ApiKeysController {
  constructor(
    private readonly repository: ApiKeysRepository,
    private readonly deps: ApiKeysControllerDeps = {},
  ) {}

  private toResponse(record: ApiKeyRow, meta: Pick<ApiKeyMetaRow, 'peerId' | 'origin' | 'lastUsedAt'>, boundIdentityId: string | null): ApiKeyResponse {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastUsedAt: meta.lastUsedAt,
      lastUsedTrackedSince: lastUsedTrackedSince(record.createdAt, this.deps.meta?.trackingSince() ?? null),
      peerId: meta.peerId,
      origin: meta.origin,
      boundIdentityId,
    }
  }

  private one(record: ApiKeyRow): ApiKeyResponse {
    const binding = this.deps.bindings?.keyBindings().find(b => b.apiKeyId === record.id)
    return this.toResponse(record, this.deps.meta?.get(record.id) ?? NO_META, binding?.identityId ?? null)
  }

  /** Throws a 400 on `peerId` unless a peer with that id is configured. */
  assertPeer(peerId: string): void {
    if (!this.deps.peerExists?.(peerId))
      throw ValidationError.forField('peerId', `No peer with id "${peerId}"`)
  }

  create(input: CreateApiKeyBody, link: { origin?: ApiKeyOrigin, peerId?: string | null } = {}): CreateApiKeyResponse {
    const rawKey = generateApiKey()
    const keyHash = hashKey(rawKey)

    const record = this.repository.create({
      keyHash,
      name: input.name,
      description: input.description,
      expiresAt: input.expiresAt,
    })
    if (link.origin)
      this.deps.meta?.setOrigin(record.id, link.origin)
    if (link.peerId)
      this.deps.meta?.setPeer(record.id, link.peerId)

    return { ...this.one(record), key: rawKey }
  }

  list(): ApiKeyResponse[] {
    const meta = this.deps.meta?.all() ?? new Map<number, ApiKeyMetaRow>()
    const bindings = new Map((this.deps.bindings?.keyBindings() ?? []).map(b => [b.apiKeyId, b.identityId]))
    return this.repository.list().map(record => this.toResponse(record, meta.get(record.id) ?? NO_META, bindings.get(record.id) ?? null))
  }

  get(id: number): ApiKeyResponse {
    const record = this.repository.get(id)
    if (!record) {
      throw new NotFoundError(`API key ${id} not found`)
    }

    return this.one(record)
  }

  /** `peerId` links the key to a configured peer (the same friend); `null` unlinks it. */
  update(id: number, input: UpdateApiKeyBody): ApiKeyResponse {
    const { peerId, ...fields } = input
    if (peerId !== undefined) {
      if (!this.repository.get(id))
        throw new NotFoundError(`API key ${id} not found`)
      if (!this.deps.meta)
        throw new BadRequestError('Linking keys to peers is not available')
      if (peerId !== null)
        this.assertPeer(peerId)
    }

    const record = this.repository.update(id, fields)
    if (!record) {
      throw new NotFoundError(`API key ${id} not found`)
    }
    if (peerId !== undefined)
      this.deps.meta?.setPeer(id, peerId)

    return this.one(record)
  }

  /** Revoke a key, with what jack knew about it: its link, last use and identity binding. */
  delete(id: number): { ok: true } {
    const deleted = this.repository.delete(id)
    if (!deleted) {
      throw new NotFoundError(`API key ${id} not found`)
    }
    this.deps.meta?.delete(id)
    this.deps.bindings?.forgetKey(id)

    return { ok: true }
  }
}
