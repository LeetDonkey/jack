import type { Friend, FriendPeer } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { buildSummary, describePeerSaveError, friendBadge, keyToReplace, keyUsage, limitsSummary, peerProblem, sameName, trafficSummary } from './friends'

// Local times, so the expectations hold in any time zone.
const now = new Date(2026, 9, 18, 15, 0)
const iso = (year: number, month: number, day: number, hours = 0, minutes = 0) => new Date(year, month, day, hours, minutes).toISOString()

function peer(overrides: Partial<FriendPeer> = {}): FriendPeer {
  return {
    id: 'p1',
    name: 'Alice',
    url: 'https://jack.alice.example',
    version: '0.1.0',
    build: null,
    online: true,
    offlineSince: null,
    lastSeenAt: null,
    lastError: null,
    lastErrorCode: null,
    checkedAt: null,
    downloaded: { today: 0, week: 0, month: 0 },
    identityId: null,
    ...overrides,
  }
}

function card(state: Friend['state'], p: FriendPeer | null = peer()): Pick<Friend, 'state' | 'name' | 'peer'> {
  return { state, name: 'Alice', peer: p }
}

describe('friendBadge', () => {
  test('describes the friendship when nothing is wrong', () => {
    expect(friendBadge(card('both'), now)).toEqual({ label: 'Connected both ways', color: 'success' })
    expect(friendBadge(card('waiting'), now)).toEqual({ label: 'Waiting for Alice', color: 'neutral' })
    expect(friendBadge(card('noKey'), now).label).toBe('Only one way')
    expect(friendBadge(card('noPeer', null), now).label).toBe('Only one way')
  })

  test('uses the status words for an offline friend', () => {
    const offline = (lastErrorCode: FriendPeer['lastErrorCode']) =>
      friendBadge(card('offline', peer({ online: false, offlineSince: iso(2026, 9, 18, 14, 2), lastErrorCode })), now).label
    expect(offline('timeout')).toBe('Offline since 14:02')
    expect(offline('unauthorized')).toBe('Rejected your key')
    expect(offline('forbidden')).toBe('Is blocking you')
    expect(offline('incompatible')).toBe('Needs a newer jack')
  })
})

describe('peerProblem', () => {
  test('is null unless the last check failed', () => {
    expect(peerProblem('Alice', { online: true, lastErrorCode: null })).toBeNull()
    expect(peerProblem('Alice', { online: null, lastErrorCode: null })).toBeNull()
  })

  test('says what to do per reason', () => {
    expect(peerProblem('Alice', { online: false, lastErrorCode: 'unauthorized' })).toContain('Alice\'s jack rejected your key')
    expect(peerProblem('Alice', { online: false, lastErrorCode: 'incompatible' })).toContain('Alice needs to update jack')
    expect(peerProblem('Alice', { online: false, lastErrorCode: 'dns' })).toBe('jack can\'t reach Alice\'s jack. The address doesn\'t resolve. Check it for typos. Downloads from them wait and retry.')
  })
})

describe('keyUsage', () => {
  test('says when a friend last used the key', () => {
    expect(keyUsage({ lastUsedAt: iso(2026, 9, 18, 14, 57), lastUsedTrackedSince: iso(2026, 9, 1) }, iso(2026, 9, 1), now)).toBe('Last connected 3 min ago')
  })

  test('says never used when tracking started with the key', () => {
    const created = iso(2026, 9, 12, 10, 0)
    expect(keyUsage({ lastUsedAt: null, lastUsedTrackedSince: created }, created, now)).toBe('Never used')
  })

  test('says not seen since tracking started for an older key', () => {
    expect(keyUsage({ lastUsedAt: null, lastUsedTrackedSince: iso(2026, 9, 12, 10, 0) }, iso(2026, 5, 1), now)).toBe('Not seen since 12 Oct')
    expect(keyUsage({ lastUsedAt: null, lastUsedTrackedSince: iso(2026, 9, 12, 10, 0) }, undefined, now)).toBe('Not seen since 12 Oct')
  })
})

describe('describePeerSaveError', () => {
  const error = (reason: Parameters<typeof describePeerSaveError>[0]['reason'], upstreamStatus: number | null = null) =>
    describePeerSaveError({ reason, upstreamStatus, message: 'handshake failed' }, 'Alice')

  test('offers to keep the friend only when their jack did not answer', () => {
    for (const reason of ['timeout', 'dns', 'refused', 'tls', 'unavailable'] as const) {
      expect(error(reason).offerForce).toBe(true)
      expect(error(reason).title).toBe('Couldn\'t reach Alice\'s jack. Their jack or proxy may not be set up yet.')
    }
    expect(error('unknown', 502).offerForce).toBe(true)
    expect(error('unknown').offerForce).toBe(false)
  })

  test('explains a jack that answered with a no', () => {
    expect(error('unauthorized')).toEqual({ title: 'Alice\'s jack rejected this key. Ask Alice for a new link.', detail: 'handshake failed', offerForce: false })
    expect(error('forbidden').title).toBe('Alice\'s jack is blocking you, possibly banned after failed attempts.')
    expect(error('incompatible').title).toBe('Alice needs to update jack.')
  })

  test('falls back to the message for other failures', () => {
    expect(describePeerSaveError({ reason: null, upstreamStatus: null, message: 'A peer with this URL already exists' }, 'Alice'))
      .toEqual({ title: 'A peer with this URL already exists', detail: null, offerForce: false })
    expect(describePeerSaveError({ reason: null, upstreamStatus: null, message: null }, '').title).toBe('Could not save this friend.')
  })

  test('works without a name', () => {
    expect(describePeerSaveError({ reason: 'unauthorized', upstreamStatus: 401, message: null }, ' ').title).toBe('Your friend\'s jack rejected this key. Ask your friend for a new link.')
  })
})

describe('summaries', () => {
  test('traffic and limits', () => {
    expect(trafficSummary({ today: 0, week: 1024, month: 1536 })).toBe('0 B today · 1.0 KB in 7 days · 1.5 KB in 30 days')
    expect(limitsSummary({ maxConcurrentUploadsPerPeer: 1, dailyUploadLimitGiBPerPeer: 50 })).toBe('1 upload at once · 50 GB a day')
    expect(limitsSummary({ maxConcurrentUploadsPerPeer: null, dailyUploadLimitGiBPerPeer: null })).toBe('no limit on uploads at once · no daily limit')
  })

  test('build', () => {
    expect(buildSummary('0.1.0', { revision: '4ca4a2a0123456', buildDate: iso(2026, 9, 17, 12) }, now)).toBe('jack 0.1.0 · build 4ca4a2a (17 Oct)')
    expect(buildSummary('0.1.0', null, now)).toBe('jack 0.1.0')
    expect(buildSummary(null, null, now)).toBeNull()
  })
})

describe('keys and names', () => {
  test('keyToReplace picks the newest key', () => {
    expect(keyToReplace([{ id: 3 }, { id: 9 }, { id: 4 }])).toEqual({ id: 9 })
    expect(keyToReplace([])).toBeNull()
  })

  test('sameName ignores case and spaces, never matches empty', () => {
    expect(sameName(' Alice ', 'alice')).toBe(true)
    expect(sameName('Alice', 'Alice B')).toBe(false)
    expect(sameName('', '')).toBe(false)
    expect(sameName(null, null)).toBe(false)
  })
})
