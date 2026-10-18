import type { LinkableKey, LinkablePeer } from './friend-links'
import { describe, expect, test } from 'bun:test'
import { friendState, KEY_ACTIVE_MS, linkFriends, namesMatch } from './friend-links'

const NOW = new Date('2026-10-18T12:00:00Z')
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

function peer(id: string, name: string, extra: Partial<LinkablePeer> = {}): LinkablePeer {
  return { id, name, online: true, identityId: null, ...extra }
}

function key(id: number, name: string | null, extra: Partial<LinkableKey> = {}): LinkableKey {
  return { id, name, peerId: null, boundIdentityId: null, origin: null, lastUsedAt: null, ...extra }
}

describe('friendState', () => {
  test('follows the friend table', () => {
    const used = [{ lastUsedAt: minutesAgo(3) }]
    expect(friendState(null, used, NOW)).toBe('noPeer')
    expect(friendState({ online: false }, used, NOW)).toBe('offline')
    expect(friendState({ online: true }, [], NOW)).toBe('noKey')
    expect(friendState({ online: false }, [], NOW)).toBe('offline')
    expect(friendState({ online: true }, [{ lastUsedAt: null }], NOW)).toBe('waiting')
    expect(friendState({ online: true }, used, NOW)).toBe('both')
  })

  test('a key counts as used for 24 hours', () => {
    const at = (ms: number) => [{ lastUsedAt: new Date(NOW.getTime() - ms).toISOString() }]
    expect(friendState({ online: true }, at(KEY_ACTIVE_MS), NOW)).toBe('both')
    expect(friendState({ online: true }, at(KEY_ACTIVE_MS + 60_000), NOW)).toBe('waiting')
  })

  test('a peer not checked yet is not offline', () => {
    expect(friendState({ online: null }, [{ lastUsedAt: minutesAgo(1) }], NOW)).toBe('both')
    expect(friendState({ online: null }, [], NOW)).toBe('noKey')
  })
})

describe('namesMatch', () => {
  test('matches the peer name and its decorated forms only', () => {
    expect(namesMatch('Alice', 'alice')).toBe(true)
    expect(namesMatch('Alice', ' Alice #2')).toBe(true)
    expect(namesMatch('Alice', 'Alice (via Carol)')).toBe(true)
    expect(namesMatch('Alice', 'Alicex')).toBe(false)
    expect(namesMatch('Alice', 'Quick link for Bob')).toBe(false)
    expect(namesMatch('Alice', null)).toBe(false)
  })
})

describe('linkFriends', () => {
  test('an explicit link wins over a matching identity', () => {
    const peers = [peer('a', 'Alice', { identityId: 'id-alice' }), peer('b', 'Bob', { identityId: 'id-bob' })]
    // Bound to Bob's identity, but linked to Alice by hand.
    const keys = [key(1, 'Shared', { peerId: 'a', boundIdentityId: 'id-bob', lastUsedAt: minutesAgo(2) })]
    const { friends } = linkFriends(peers, keys, NOW)

    const alice = friends.find(f => f.key === 'peer:a')!
    const bob = friends.find(f => f.key === 'peer:b')!
    expect(alice.keys.map(k => [k.id, k.link])).toEqual([[1, 'explicit']])
    expect(alice.state).toBe('both')
    expect(bob.keys).toEqual([])
    expect(bob.state).toBe('noKey')
  })

  test('a key bound to a peer\'s identity joins it', () => {
    const { friends, unlinked } = linkFriends(
      [peer('a', 'Alice', { identityId: 'id-alice' })],
      [key(1, 'Something else', { boundIdentityId: 'id-alice' })],
      NOW,
    )
    expect(friends).toHaveLength(1)
    expect(friends[0]!.keys.map(k => [k.id, k.link])).toEqual([[1, 'identity']])
    expect(friends[0]!.state).toBe('waiting')
    expect(unlinked).toEqual({ peers: [], keys: [] })
  })

  test('names never link; a matching name is only a suggestion', () => {
    const { friends, unlinked } = linkFriends(
      [peer('a', 'Alice')],
      [key(1, 'Alice'), key(2, 'Alice #2', { origin: 'quick-link' }), key(3, 'Prowlarr')],
      NOW,
    )
    const alice = friends.find(f => f.key === 'peer:a')!
    expect(alice.keys).toEqual([])
    expect(alice.state).toBe('noKey')
    expect(alice.suggestedKeyIds).toEqual([1, 2])

    // The quick-link key is a friend of its own until linked, with the peer suggested.
    const invited = friends.find(f => f.key === 'key:2')!
    expect(invited).toMatchObject({ name: 'Alice #2', peer: null, state: 'noPeer', suggestedPeerId: 'a' })

    // Keys made by hand belong to no friend.
    expect(unlinked.keys.map(k => [k.id, k.suggestedPeerId])).toEqual([[1, 'a'], [3, null]])
  })

  test('a friend\'s keys without a peer are grouped by identity', () => {
    const { friends } = linkFriends([], [
      key(1, 'Carol', { boundIdentityId: 'id-carol', lastUsedAt: minutesAgo(1) }),
      key(2, 'Carol old', { boundIdentityId: 'id-carol' }),
      key(3, 'Dave', { origin: 'introduction' }),
      key(4, 'Erin', { peerId: 'removed-peer' }),
    ], NOW)
    expect(friends.map(f => [f.key, f.keys.map(k => k.id), f.state])).toEqual([
      ['identity:id-carol', [1, 2], 'noPeer'],
      ['key:3', [3], 'noPeer'],
      ['key:4', [4], 'noPeer'],
    ])
  })

  test('a second peer for the same jack identity is left unlinked, pointing at the card', () => {
    const { friends, unlinked } = linkFriends(
      [peer('new', 'Alice', { identityId: 'id-alice' }), peer('old', 'Alice (old address)', { identityId: 'id-alice', online: false })],
      [key(1, 'Alice', { peerId: 'old', lastUsedAt: minutesAgo(5) })],
      NOW,
    )
    expect(friends.map(f => f.key)).toEqual(['peer:new'])
    // A key linked to the second peer lands on that person's card.
    expect(friends[0]!.keys.map(k => k.id)).toEqual([1])
    expect(unlinked.peers.map(p => [p.id, p.sameAs])).toEqual([['old', 'peer:new']])
  })

  test('of two peers for one jack, the card shows the reachable one, even when the other comes first', () => {
    const old = peer('old', 'Alice (old address)', { identityId: 'id-alice', online: false, lastSeenAt: minutesAgo(600) })
    const moved = peer('new', 'Alice', { identityId: 'id-alice', online: true, lastSeenAt: minutesAgo(2) })
    const { friends, unlinked } = linkFriends([old, moved], [key(1, 'Alice', { peerId: 'old', lastUsedAt: minutesAgo(5) })], NOW)
    expect(friends.map(f => [f.key, f.state])).toEqual([['peer:new', 'both']])
    expect(friends[0]!.keys.map(k => k.id)).toEqual([1])
    expect(unlinked.peers.map(p => [p.id, p.sameAs])).toEqual([['old', 'peer:new']])

    // Not checked yet beats offline; between equals, the one seen last wins.
    expect(linkFriends([old, { ...moved, online: null }], [], NOW).friends.map(f => f.key)).toEqual(['peer:new'])
    const seenEarlier = { ...moved, online: false, lastSeenAt: minutesAgo(900) }
    expect(linkFriends([seenEarlier, old], [], NOW).friends.map(f => f.key)).toEqual(['peer:old'])
    expect(linkFriends([{ ...old, lastSeenAt: null }, seenEarlier], [], NOW).friends.map(f => f.key)).toEqual(['peer:new'])
  })

  test('needs-action states sort first, then names', () => {
    const { friends } = linkFriends(
      [
        peer('a', 'Anna'),
        peer('b', 'Bea', { online: false }),
        peer('c', 'Carl'),
        peer('d', 'Dora'),
        peer('e', 'Emil'),
      ],
      [
        key(1, 'Anna', { peerId: 'a', lastUsedAt: minutesAgo(1) }),
        key(2, 'Carl', { peerId: 'c' }),
        key(3, 'Zoe', { origin: 'quick-link' }),
      ],
      NOW,
    )
    expect(friends.map(f => [f.name, f.state])).toEqual([
      ['Bea', 'offline'],
      ['Dora', 'noKey'],
      ['Emil', 'noKey'],
      ['Zoe', 'noPeer'],
      ['Carl', 'waiting'],
      ['Anna', 'both'],
    ])
  })
})
