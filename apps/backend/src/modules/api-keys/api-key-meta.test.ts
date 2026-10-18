import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { ApiKeyMeta, LAST_USED_WRITE_INTERVAL_MS, lastUsedTrackedSince } from './api-key-meta'

function meta(start = Date.parse('2026-10-18T10:00:00Z')) {
  const clock = { now: start }
  const sqlite = new Database(':memory:')
  return { store: new ApiKeyMeta(sqlite, () => new Date(clock.now)), clock, sqlite }
}

describe('ApiKeyMeta', () => {
  test('stamps last use at most once per key per minute', () => {
    const { store, clock } = meta()
    expect(store.touch(1)).toBe(true)
    expect(store.get(1).lastUsedAt).toBe('2026-10-18T10:00:00.000Z')

    clock.now += 30_000
    expect(store.touch(1)).toBe(false)
    // Another key has its own minute.
    expect(store.touch(2)).toBe(true)
    expect(store.get(1).lastUsedAt).toBe('2026-10-18T10:00:00.000Z')

    clock.now += LAST_USED_WRITE_INTERVAL_MS - 30_000
    expect(store.touch(1)).toBe(true)
    expect(store.get(1).lastUsedAt).toBe('2026-10-18T10:01:00.000Z')
  })

  test('a failed write does not throw', () => {
    const { store, sqlite } = meta()
    sqlite.close()
    expect(store.touch(1)).toBe(false)
  })

  test('keeps the peer link, origin and last use apart', () => {
    const { store } = meta()
    expect(store.get(7)).toEqual({ keyId: 7, peerId: null, origin: null, lastUsedAt: null })

    store.setOrigin(7, 'quick-link')
    store.setPeer(7, 'abcd1234')
    store.touch(7)
    expect(store.get(7)).toEqual({ keyId: 7, peerId: 'abcd1234', origin: 'quick-link', lastUsedAt: '2026-10-18T10:00:00.000Z' })

    store.setPeer(7, null)
    expect(store.get(7).peerId).toBeNull()
    expect(store.get(7).origin).toBe('quick-link')
    expect([...store.all().keys()]).toEqual([7])
  })

  test('links follow a peer to its new id, and go with the key', () => {
    const { store } = meta()
    store.setPeer(1, 'old')
    store.setPeer(2, 'old')
    store.setPeer(3, 'other')
    store.reassignPeer('old', 'new')
    expect([store.get(1).peerId, store.get(2).peerId, store.get(3).peerId]).toEqual(['new', 'new', 'other'])

    store.touch(1)
    store.delete(1)
    expect(store.get(1)).toEqual({ keyId: 1, peerId: null, origin: null, lastUsedAt: null })
    // The throttle forgets the key too.
    expect(store.touch(1)).toBe(true)
  })

  test('records when usage tracking began, once', () => {
    const { store, clock, sqlite } = meta()
    expect(store.trackingSince()).toBe('2026-10-18T10:00:00.000Z')
    // A later boot keeps the first value.
    clock.now += 86_400_000
    expect(new ApiKeyMeta(sqlite, () => new Date(clock.now)).trackingSince()).toBe('2026-10-18T10:00:00.000Z')

    // Last use counts from creation, or from the start of tracking for an older key.
    expect(lastUsedTrackedSince('2026-10-19T08:00:00.000Z', store.trackingSince())).toBe('2026-10-19T08:00:00.000Z')
    expect(lastUsedTrackedSince('2026-05-01T08:00:00.000Z', store.trackingSince())).toBe('2026-10-18T10:00:00.000Z')
    expect(lastUsedTrackedSince('2026-05-01T08:00:00.000Z', null)).toBe('2026-05-01T08:00:00.000Z')
  })
})
