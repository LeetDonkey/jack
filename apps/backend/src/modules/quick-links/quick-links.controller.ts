import type { ApiKeyResponse, ApiKeysController } from '../api-keys/api-keys.controller'
import type { ConfigService } from '../config/config.service'
import type { CreateQuickLinkBody } from './quick-links.schema'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { BadRequestError } from '../../lib/errors/BadRequestError'

export interface QuickLinkPayload {
  v: 1
  type: 'peer'
  name: string
  url: string
  apiKey: string
  headers: Record<string, string>
}

/** What happened to the key named by `replaceKeyId`. */
export interface ReplacedKey {
  keyId: number
  /** True when jack revoked it: it was never used and no jack identity is bound to it. */
  revoked: boolean
  /**
   * Why it was kept (the UI asks "Replace" or "Keep both"); null when revoked.
   * - `used`: `lastUsedAt` is set.
   * - `bound`: a jack identity is bound to it.
   * - `unknown`: it was made before jack recorded last use and hasn't been used
   *   since (`lastUsedTrackedSince`), so it may still be in use.
   */
  keptBecause: 'used' | 'bound' | 'unknown' | null
  lastUsedAt: string | null
  /** When `lastUsedAt` starts to count (see ApiKeyResponse). */
  lastUsedTrackedSince: string
}

export interface CreateQuickLinkResponse {
  link: string
  key: ApiKeyResponse
  /** Null unless the request named `replaceKeyId`. */
  replaced: ReplacedKey | null
}

export function encodeQuickLink(payload: QuickLinkPayload): string {
  const link = `jack-link:v1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  if (link.length > 32_768)
    throw new BadRequestError('The configured external access profile is too large for a quick link')
  return link
}

export class QuickLinksController {
  constructor(
    private readonly configService: ConfigService,
    private readonly apiKeysController: ApiKeysController,
  ) {}

  create(input: CreateQuickLinkBody): CreateQuickLinkResponse {
    // Resolve every ConfigSecret before issuing a credential. A broken or missing
    // external profile therefore cannot leave an orphan API key behind.
    let external
    try {
      external = this.configService.getResolvedExternalJack()
    }
    catch (error) {
      if (error instanceof z.ZodError)
        throw new BadRequestError('The external access profile contains a secret that could not be resolved')
      throw error
    }
    if (!external)
      throw new BadRequestError('Configure Jack external access before generating a quick link')

    // Validate the link targets up front too (404 / 400), for the same reason.
    if (input.peerId)
      this.apiKeysController.assertPeer(input.peerId)
    const previous = input.replaceKeyId ? this.apiKeysController.get(input.replaceKeyId) : null

    const created = this.apiKeysController.create({
      name: input.keyName,
      description: input.keyDescription,
      expiresAt: input.expiresAt,
    }, {
      origin: 'quick-link',
      // A replacement belongs to the same friend as the key it replaces.
      peerId: input.peerId ?? previous?.peerId ?? null,
    })
    const { key: rawKey, ...key } = created

    let link: string
    try {
      link = encodeQuickLink({
        v: 1,
        type: 'peer',
        name: input.peerName,
        url: external.url,
        apiKey: rawKey,
        headers: external.headers,
      })
    }
    catch (error) {
      // Encoding should be infallible for the validated string-only payload, but
      // compensate if that contract changes so a credential is never orphaned.
      this.apiKeysController.delete(created.id)
      throw error
    }

    return { link, key, replaced: previous ? this.replace(previous) : null }
  }

  // A key nobody ever used and no jack identity is bound to can't be in use, so
  // the new link replaces it outright. Otherwise the friend may still rely on it,
  // and the caller decides (DELETE /api-keys/:id to replace it). A key older than
  // usage tracking with no use since may be in use by a jack that hasn't called
  // in yet, so it is kept too.
  private replace(previous: ApiKeyResponse): ReplacedKey {
    const untracked = Date.parse(previous.lastUsedTrackedSince) > Date.parse(previous.createdAt)
    const keptBecause = previous.lastUsedAt ? 'used' : previous.boundIdentityId ? 'bound' : untracked ? 'unknown' : null
    if (!keptBecause)
      this.apiKeysController.delete(previous.id)
    return { keyId: previous.id, revoked: !keptBecause, keptBecause, lastUsedAt: previous.lastUsedAt, lastUsedTrackedSince: previous.lastUsedTrackedSince }
  }
}
