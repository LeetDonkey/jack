import type { Friend, FriendKey, FriendPeer } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { buildSummary, describePeerSaveError, friendBadge, friendKeyLabels, friendPrompt, friendSilence, keyToReplace, keyUsage, limitsLabel, limitsSummary, peerProblem, revokeKeyWords, sameName, trafficSummary } from './friends'

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

type CardKey = Pick<FriendKey, 'id' | 'lastUsedAt' | 'lastUsedTrackedSince'>

// A key made on 1 Oct, when jack already recorded key use.
function key(overrides: Partial<CardKey> = {}): CardKey {
  return { id: 1, lastUsedAt: null, lastUsedTrackedSince: iso(2026, 9, 1), ...overrides }
}

function card(state: Friend['state'], p: FriendPeer | null = peer(), keys: CardKey[] = [key()]) {
  return { state, name: 'Alice', peer: p, keys }
}

describe('friendBadge', () => {
  test('describes the friendship when nothing is wrong', () => {
    expect(friendBadge(card('both'), now)).toEqual({ label: 'Connected both ways', color: 'success' })
    expect(friendBadge(card('waiting'), now)).toEqual({ label: 'Waiting for Alice', color: 'neutral' })
    expect(friendBadge(card('noKey'), now).label).toBe('Only one way')
    expect(friendBadge(card('noPeer', null), now).label).toBe('Only one way')
  })

  test('says one way since when a friend whose key was used before hasn\'t connected', () => {
    // The peer is online: the badge mustn't say "not connected" next to "Online".
    const stale = card('stale', peer(), [key({ lastUsedAt: iso(2026, 9, 12, 9, 30) }), key({ id: 2, lastUsedAt: iso(2026, 9, 14, 22, 0) })])
    expect(friendBadge(stale, now)).toEqual({ label: 'Only one way since 14 Oct', color: 'warning' })
    expect(friendBadge(card('stale', peer(), [key()]), now).label).toBe('Only one way for over a day')
  })

  test('says one way since when for a waiting friend whose key is older than the record of key use', () => {
    const old = card('waiting', peer(), [key({ lastUsedTrackedSince: iso(2026, 9, 12, 10, 0) })])
    expect(friendBadge(old, now, { 1: iso(2026, 5, 1) })).toEqual({ label: 'Only one way since 12 Oct', color: 'warning' })
    // Until the creation times load, the backend's word stands.
    expect(friendBadge(old, now).label).toBe('Waiting for Alice')
  })

  test('stays neutral for an old key while the record of key use is less than a day old', () => {
    // Updated at 14:50, ten minutes ago: Alice's jack just hasn't connected since.
    const updated = card('waiting', peer(), [key({ lastUsedTrackedSince: iso(2026, 9, 18, 14, 50) })])
    expect(friendBadge(updated, now, { 1: iso(2026, 9, 12) })).toEqual({ label: 'Waiting for Alice\'s jack', color: 'neutral' })
    expect(friendBadge({ ...updated, name: ' ' }, now, { 1: iso(2026, 9, 12) }).label).toBe('Waiting for your friend\'s jack')
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

describe('friendSilence', () => {
  test('is null unless the card is waiting or stale', () => {
    for (const state of ['both', 'offline', 'noKey', 'noPeer'] as const)
      expect(friendSilence(card(state), now)).toBeNull()
  })

  test('waiting means no key was ever used', () => {
    expect(friendSilence(card('waiting'), now, { 1: iso(2026, 9, 1) })).toEqual({ kind: 'waiting' })
    expect(friendSilence(card('waiting'), now)).toEqual({ kind: 'waiting' })
  })

  test('stale gives the last use of any key', () => {
    const keys = [key({ lastUsedAt: iso(2026, 9, 12) }), key({ id: 2 }), key({ id: 3, lastUsedAt: iso(2026, 9, 15) })]
    expect(friendSilence(card('stale', peer(), keys), now)).toEqual({ kind: 'quiet', since: iso(2026, 9, 15) })
  })

  test('an old key counts as quiet only after a day of recording key use, like the backend\'s stale', () => {
    const made = { 1: iso(2026, 9, 12) }
    const trackedFrom = (since: string) => card('waiting', peer(), [key({ lastUsedTrackedSince: since })])
    // Tracking started a few minutes ago (the update): too soon to tell.
    expect(friendSilence(trackedFrom(iso(2026, 9, 18, 14, 57)), now, made)).toEqual({ kind: 'tooSoon' })
    // Exactly 24 hours is still too soon; the backend's window includes it too.
    expect(friendSilence(trackedFrom(iso(2026, 9, 17, 15, 0)), now, made)).toEqual({ kind: 'tooSoon' })
    expect(friendSilence(trackedFrom(iso(2026, 9, 17, 14, 59)), now, made)).toEqual({ kind: 'quiet', since: iso(2026, 9, 17, 14, 59) })
  })

  test('a new key never used next to an old one waits on the old one', () => {
    // Created right after the update ("Send a new link"), never used.
    const keys = [key({ lastUsedTrackedSince: iso(2026, 9, 18, 14, 50) }), key({ id: 2, lastUsedTrackedSince: iso(2026, 9, 18, 14, 55) })]
    const made = { 1: iso(2026, 9, 12), 2: iso(2026, 9, 18, 14, 55) }
    expect(friendSilence(card('waiting', peer(), keys), now, made)).toEqual({ kind: 'tooSoon' })
  })
})

describe('friendPrompt', () => {
  test('asks for the missing half', () => {
    expect(friendPrompt(card('noPeer', null), now)?.action).toBe('add')
    expect(friendPrompt(card('noKey', peer(), []), now)).toMatchObject({ text: 'Alice can\'t download from you yet.', action: 'invite' })
    expect(friendPrompt(card('both', peer(), [key({ lastUsedAt: iso(2026, 9, 18, 14, 0) })]), now)).toBeNull()
    expect(friendPrompt(card('offline', peer({ online: false })), now)).toBeNull()
  })

  test('offers a new link only while the friend never used a key', () => {
    expect(friendPrompt(card('waiting'), now)).toMatchObject({ text: 'Waiting for Alice to add you.', hint: 'They add you by pasting the link you sent. Lost it?', action: 'newLink' })
  })

  test('points a stale friend at your address instead', () => {
    const prompt = friendPrompt(card('stale', peer(), [key({ lastUsedAt: iso(2026, 9, 15, 8, 0) })]), now)
    expect(prompt).toEqual({
      text: 'Alice\'s jack hasn\'t connected to yours since 15 Oct.',
      hint: 'Check that your address still works, and ask Alice what their jack shows for you.',
      label: 'Check your address',
      icon: 'i-ph-plugs',
      action: 'checkAddress',
    })
    const old = card('waiting', peer(), [key({ lastUsedTrackedSince: iso(2026, 9, 12, 10, 0) })])
    expect(friendPrompt(old, now, { 1: iso(2026, 5, 1) })?.text).toBe('Alice\'s jack hasn\'t connected to yours since 12 Oct.')
  })

  test('asks nothing right after an update, before an old key had a day to show up', () => {
    // jack started recording key use at 14:57; Alice's key is from 12 Oct and her jack hasn't connected since 14:57.
    const updated = card('waiting', peer(), [key({ lastUsedTrackedSince: iso(2026, 9, 18, 14, 57) })])
    expect(friendPrompt(updated, now, { 1: iso(2026, 9, 12) })).toBeNull()
    expect(friendPrompt({ ...updated, peer: peer({ online: null }) }, now, { 1: iso(2026, 9, 12) })).toBeNull()
  })
})

describe('friendKeyLabels', () => {
  const named = (id: number, name: string | null) => ({ id, name })

  test('says nothing for a friend\'s only key that carries their name', () => {
    expect(friendKeyLabels('Alice', [named(1, ' alice ')], {}, now)).toEqual({ 1: null })
  })

  test('names a key whose name no other key has', () => {
    expect(friendKeyLabels('Alice', [named(1, 'Alice laptop')], {}, now)).toEqual({ 1: '\'Alice laptop\'' })
    expect(friendKeyLabels('Alice', [named(1, 'Alice'), named(2, 'Alice laptop')], {}, now)).toEqual({ 1: '\'Alice\'', 2: '\'Alice laptop\'' })
  })

  test('tells keys with the same name apart by the day they were made', () => {
    const keys = [named(1, 'Alice'), named(2, 'Alice')]
    expect(friendKeyLabels('Alice', keys, { 1: iso(2026, 9, 12, 9, 0), 2: iso(2026, 9, 18, 14, 0) }, now)).toEqual({ 1: 'made 12 Oct', 2: 'made 18 Oct' })
    expect(friendKeyLabels('Alice', keys, { 1: iso(2026, 9, 18, 9, 5), 2: iso(2026, 9, 18, 14, 0) }, now)).toEqual({ 1: 'made 18 Oct, 09:05', 2: 'made 18 Oct, 14:00' })
    expect(friendKeyLabels('Alice', keys, { 1: iso(2026, 9, 18, 9, 5), 2: iso(2026, 9, 18, 9, 5) }, now)).toEqual({ 1: 'made 18 Oct, 09:05 (#1)', 2: 'made 18 Oct, 09:05 (#2)' })
  })

  test('falls back to the number while creation times are unknown', () => {
    expect(friendKeyLabels('Alice', [named(1, 'Alice'), named(2, 'Alice')], undefined, now)).toEqual({ 1: '#1', 2: '#2' })
    expect(friendKeyLabels('Alice', [named(3, null)], undefined, now)).toEqual({ 3: '#3' })
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

  test('says not connected since tracking started for an older key', () => {
    expect(keyUsage({ lastUsedAt: null, lastUsedTrackedSince: iso(2026, 9, 12, 10, 0) }, iso(2026, 5, 1), now)).toBe('Not connected since 12 Oct')
    expect(keyUsage({ lastUsedAt: null, lastUsedTrackedSince: iso(2026, 9, 12, 10, 0) }, undefined, now)).toBe('Not connected since 12 Oct')
  })
})

describe('revokeKeyWords', () => {
  // After "Keep both": key 1 made 12 Oct, key 2 made 18 Oct, both named after Alice.
  const made = { 1: iso(2026, 9, 12, 9, 0), 2: iso(2026, 9, 18, 9, 0) }
  const both = (old: string | null, fresh: string | null) => [
    { id: 1, name: 'Alice', lastUsedAt: old, lastUsedTrackedSince: made[1] },
    { id: 2, name: 'Alice', lastUsedAt: fresh, lastUsedTrackedSince: made[2] },
  ]

  test('reassures when their jack uses another key', () => {
    // Alice pasted the new link: the old key was last used 3 days ago.
    expect(revokeKeyWords('Alice', both(iso(2026, 9, 15, 15, 0), iso(2026, 9, 18, 14, 58)), 1, made, now)).toEqual({
      label: 'made 12 Oct',
      usage: 'Last connected 3 days ago',
      warning: null,
      text: 'Alice\'s jack can\'t use this key once you revoke it. Their other key keeps working. This can\'t be undone.',
    })
    // A key never used, next to one in use.
    expect(revokeKeyWords('Alice', both(iso(2026, 9, 18, 14, 58), null), 2, made, now)?.warning).toBeNull()
  })

  test('warns about the key their jack used last and points at the older one', () => {
    expect(revokeKeyWords('Alice', both(iso(2026, 9, 15, 15, 0), iso(2026, 9, 18, 14, 58)), 2, made, now)).toEqual({
      label: 'made 18 Oct',
      usage: 'Last connected 2 min ago',
      warning: {
        title: 'Alice\'s jack uses this key.',
        text: 'If you revoke it, Alice can\'t download from you until they paste a new link. To revoke the older key instead, cancel and click Revoke next to key made 12 Oct (last connected 3 days ago).',
      },
      text: 'This can\'t be undone.',
    })
  })

  test('says to wait while their jack still uses the older key', () => {
    // Alice hasn't pasted the new link yet.
    expect(revokeKeyWords('Alice', both(iso(2026, 9, 18, 14, 58), null), 1, made, now)?.warning).toEqual({
      title: 'Alice\'s jack uses this key.',
      text: 'If you revoke it, Alice can\'t download from you until they paste a new link. Wait until Alice has pasted your new link, then revoke this key.',
    })
  })

  test('warns on a tie, and when only this key was ever used', () => {
    const tie = iso(2026, 9, 18, 14, 58)
    expect(revokeKeyWords('Alice', both(tie, tie), 1, made, now)?.warning).not.toBeNull()
    expect(revokeKeyWords('Alice', both(tie, tie), 2, made, now)?.warning).not.toBeNull()
    expect(revokeKeyWords('Alice', both(null, iso(2026, 9, 18, 10, 0)), 2, made, now)?.warning).not.toBeNull()
  })

  test('names several older keys without listing them', () => {
    const keys = [...both(iso(2026, 9, 13), iso(2026, 9, 18, 10, 0)), { id: 3, name: 'Alice', lastUsedAt: iso(2026, 9, 18, 14, 58), lastUsedTrackedSince: iso(2026, 9, 18) }]
    expect(revokeKeyWords('Alice', keys, 3, { ...made, 3: iso(2026, 9, 18, 10, 0) }, now)?.warning?.text)
      .toBe('If you revoke it, Alice can\'t download from you until they paste a new link. To revoke an older key instead, cancel and click Revoke next to it.')
  })

  test('reassures while no key was used, and is null for an unknown key', () => {
    expect(revokeKeyWords('Alice', both(null, null), 1, made, now)?.text).toBe('Alice\'s jack can\'t use this key once you revoke it. Their other key keeps working. This can\'t be undone.')
    expect(revokeKeyWords('Alice', both(null, null), 9, made, now)).toBeNull()
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

  // jack applies the limits per key, so a friend who kept two keys gets them twice.
  test('limits label', () => {
    expect(limitsLabel(1)).toBe('Limits per key')
    expect(limitsLabel(2)).toBe('Limits for each of their keys')
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
