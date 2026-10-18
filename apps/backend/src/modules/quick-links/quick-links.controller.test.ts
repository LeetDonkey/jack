import type { KeyBinding } from '../api-keys/api-keys.controller'
import type { ConfigService } from '../config/config.service'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { ValidationError } from '../../lib/validation'
import { ApiKeyMeta } from '../api-keys/api-key-meta'
import { ApiKeysController } from '../api-keys/api-keys.controller'
import { ApiKeysRepository } from '../api-keys/api-keys.repository'
import { QuickLinksController } from './quick-links.controller'

const TRACKING_SINCE = '2026-01-01T00:00:00.000Z'

function setup() {
  const sqlite = new Database(':memory:')
  const db = drizzle({ client: sqlite, schema })
  runMigrations(db)
  const repository = new ApiKeysRepository(db)
  // Usage tracking began before any key these tests make.
  const meta = new ApiKeyMeta(sqlite, () => new Date(TRACKING_SINCE))
  const bindings: KeyBinding[] = []
  const forgotten: number[] = []
  const keys = new ApiKeysController(repository, {
    meta,
    bindings: { keyBindings: () => bindings, forgetKey: id => forgotten.push(id) },
    peerExists: id => id === 'alice-peer',
  })
  const config = { getResolvedExternalJack: () => ({ url: 'https://bob.example.com', headers: {} }) } as unknown as ConfigService
  const links = new QuickLinksController(config, keys)
  const create = (extra: Record<string, unknown> = {}) => links.create({ peerName: 'Bob', keyName: 'Alice', ...extra })
  return { sqlite, repository, meta, bindings, forgotten, keys, create }
}

describe('POST /quick-links', () => {
  test('records the key as made by a quick link, linked to the given peer', () => {
    const { create } = setup()
    const { key, replaced } = create({ peerId: 'alice-peer' })
    expect(key).toMatchObject({ name: 'Alice', origin: 'quick-link', peerId: 'alice-peer', lastUsedAt: null, boundIdentityId: null })
    expect(replaced).toBeNull()
  })

  test('refuses an unknown peer before issuing a key', () => {
    const { create, repository } = setup()
    expect(() => create({ peerId: 'nobody' })).toThrow(ValidationError)
    expect(repository.list()).toEqual([])
  })

  test('refuses an unknown key to replace before issuing a key', () => {
    const { create, repository } = setup()
    expect(() => create({ replaceKeyId: 99 })).toThrow(NotFoundError)
    expect(repository.list()).toEqual([])
  })

  test('replacing a key nobody used revokes it, and the new key keeps its peer', () => {
    const { create, repository, forgotten } = setup()
    const first = create({ peerId: 'alice-peer' }).key

    const { key, replaced } = create({ replaceKeyId: first.id })
    expect(replaced).toEqual({ keyId: first.id, revoked: true, keptBecause: null, lastUsedAt: null, lastUsedTrackedSince: first.createdAt })
    expect(repository.get(first.id)).toBeNull()
    expect(forgotten).toEqual([first.id])
    expect(key.peerId).toBe('alice-peer')
  })

  test('replacing a key a jack used keeps it and says why', () => {
    const { create, repository, meta } = setup()
    const first = create().key
    meta.touch(first.id)

    const { replaced } = create({ replaceKeyId: first.id })
    expect(replaced).toMatchObject({ keyId: first.id, revoked: false, keptBecause: 'used' })
    expect(replaced!.lastUsedAt).not.toBeNull()
    expect(repository.get(first.id)).not.toBeNull()
  })

  test('replacing a key bound to a jack identity keeps it', () => {
    const { create, repository, bindings } = setup()
    const first = create().key
    bindings.push({ apiKeyId: first.id, identityId: 'id-alice', boundAt: '2026-10-18T10:00:00.000Z' })

    const { replaced } = create({ replaceKeyId: first.id })
    expect(replaced).toEqual({ keyId: first.id, revoked: false, keptBecause: 'bound', lastUsedAt: null, lastUsedTrackedSince: first.createdAt })
    expect(repository.get(first.id)).not.toBeNull()
  })

  test('a key made before usage tracking began is kept: a jack may use it without having called in yet', () => {
    const { create, repository, sqlite } = setup()
    const first = create().key
    sqlite.query('update api_keys set created_at = ? where id = ?').run('2025-12-01T00:00:00.000Z', first.id)

    const { replaced } = create({ replaceKeyId: first.id })
    expect(replaced).toEqual({ keyId: first.id, revoked: false, keptBecause: 'unknown', lastUsedAt: null, lastUsedTrackedSince: TRACKING_SINCE })
    expect(repository.get(first.id)).not.toBeNull()
  })
})
