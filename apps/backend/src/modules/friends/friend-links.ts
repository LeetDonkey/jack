/**
 * One friend is one person with up to two halves: a peer (you download from
 * them) and API keys (they download from you). This module puts the halves
 * together, in this order, first match wins:
 *
 * 1. Explicit: the key's `peerId` (set by a quick link, an introduction or by hand).
 * 2. Identity: the key's bound jack identity equals the identity the peer reports.
 * 3. Until a peer has reported its identity (it was down since jack started
 *    keeping identities, or since this boot): the keys of one bound identity
 *    whose names match that peer and no other peer, whatever its identity (see
 *    adoptByName).
 *
 * Otherwise names never link anything; a matching name only produces a suggestion.
 */

/** Ordered so the states that need the user's action come first. */
export const FRIEND_STATES = ['offline', 'noKey', 'noPeer', 'stale', 'waiting', 'both'] as const
export type FriendState = typeof FRIEND_STATES[number]

/** A key counts as in use while a friend's jack used it within this window. */
export const KEY_ACTIVE_MS = 24 * 60 * 60_000

export interface LinkablePeer {
  id: string
  name: string
  /** From the health check; null before the first check. */
  online: boolean | null
  /** When a health check last passed; picks between two peers of one jack. */
  lastSeenAt?: string | null
  identityId: string | null
}

export interface LinkableKey {
  id: number
  name: string | null
  peerId: string | null
  boundIdentityId: string | null
  origin: string | null
  lastUsedAt: string | null
}

/** How a key came to be on a peer's card; null on a card without a peer. */
export type KeyLink = 'explicit' | 'identity' | null

export interface Friend<P extends LinkablePeer = LinkablePeer, K extends LinkableKey = LinkableKey> {
  /** Stable card id: `peer:<peer id>`, or for a friend without a peer `identity:<identity id>` or `key:<key id>`. */
  key: string
  name: string
  peer: P | null
  keys: Array<K & { link: KeyLink }>
  state: FriendState
  /** Keys on no peer's card whose name matches this peer's name. A suggestion for "Link"; never applied. */
  suggestedKeyIds: number[]
  /** For a friend without a peer: a peer whose name matches. A suggestion; never applied. */
  suggestedPeerId: string | null
}

export interface FriendLinks<P extends LinkablePeer, K extends LinkableKey> {
  friends: Array<Friend<P, K>>
  unlinked: {
    /** A second peer for a jack identity that already has a card (`sameAs` is that card's key). */
    peers: Array<P & { sameAs: string }>
    /** Keys that belong to no friend: not linked, never used for introduction mail, and not made by a quick link or introduction. */
    keys: Array<K & { suggestedPeerId: string | null }>
  }
}

/**
 * - `offline`: the peer's last health check failed.
 * - `noKey`: a peer, but no key: they can't download from you.
 * - `noPeer`: keys, but no peer: you don't download from them.
 * - `both`: a peer that isn't offline and a key used in the last 24 hours.
 * - `stale`: a peer and keys; a key was used before, but none in the last 24 hours.
 * - `waiting`: a peer and keys, none ever used.
 *
 * A peer that wasn't checked yet (`online: null`) doesn't count as offline.
 */
export function friendState(peer: Pick<LinkablePeer, 'online'> | null, keys: ReadonlyArray<Pick<LinkableKey, 'lastUsedAt'>>, now: Date): FriendState {
  if (!peer)
    return 'noPeer'
  if (peer.online === false)
    return 'offline'
  if (keys.length === 0)
    return 'noKey'
  const used = keys.filter(k => k.lastUsedAt != null)
  if (used.length === 0)
    return 'waiting'
  const active = used.some(k => now.getTime() - Date.parse(k.lastUsedAt!) <= KEY_ACTIVE_MS)
  return active ? 'both' : 'stale'
}

function normalize(name: string | null): string {
  return (name ?? '').trim().toLowerCase()
}

/** "Alice" matches the key names "Alice", "alice", "Alice #2" and "Alice (via Carol)". */
export function namesMatch(peerName: string, keyName: string | null): boolean {
  const peer = normalize(peerName)
  const key = normalize(keyName)
  if (!peer || !key)
    return false
  return key === peer || (key.startsWith(peer) && ' (#-\''.includes(key.charAt(peer.length)))
}

// A key someone made for a friend, as opposed to one for another tool.
function belongsToFriend(key: LinkableKey): boolean {
  return key.origin != null || key.boundIdentityId != null || key.peerId != null
}

// Online beats not checked yet, which beats offline.
function reachability(peer: LinkablePeer): number {
  return peer.online === true ? 2 : peer.online === null ? 1 : 0
}

/** Whether `a` should show on its jack's card instead of `b`: the more reachable, then the one seen last. */
function betterPeer(a: LinkablePeer, b: LinkablePeer): boolean {
  const byReach = reachability(a) - reachability(b)
  if (byReach !== 0)
    return byReach > 0
  const seen = (peer: LinkablePeer) => (peer.lastSeenAt ? Date.parse(peer.lastSeenAt) : 0) || 0
  return seen(a) > seen(b)
}

export interface LinkOptions {
  /** Whether a peer's jack hasn't answered about its identity since jack started (see adoptByName). */
  identityPending?: (peerId: string) => boolean
}

export function linkFriends<P extends LinkablePeer, K extends LinkableKey>(peers: P[], keys: K[], now: Date, options: LinkOptions = {}): FriendLinks<P, K> {
  const cards: Array<Friend<P, K>> = []
  const peerCards: Array<{ card: Friend<P, K>, peer: P }> = []
  const cardOfPeer = new Map<string, Friend<P, K>>()
  const cardOfIdentity = new Map<string, Friend<P, K>>()
  const unlinkedPeers: Array<P & { sameAs: string }> = []

  // Two peers can report the same jack (a friend who moved, with the old address
  // still configured). The better one gets the card, whatever the config order.
  const shown = new Map<string, P>()
  for (const peer of peers) {
    const current = peer.identityId ? shown.get(peer.identityId) : undefined
    if (peer.identityId && (!current || betterPeer(peer, current)))
      shown.set(peer.identityId, peer)
  }

  const duplicates: P[] = []
  for (const peer of peers) {
    if (peer.identityId && shown.get(peer.identityId) !== peer) {
      duplicates.push(peer)
      continue
    }
    const card: Friend<P, K> = { key: `peer:${peer.id}`, name: peer.name, peer, keys: [], state: 'noKey', suggestedKeyIds: [], suggestedPeerId: null }
    cards.push(card)
    peerCards.push({ card, peer })
    cardOfPeer.set(peer.id, card)
    if (peer.identityId)
      cardOfIdentity.set(peer.identityId, card)
  }
  for (const peer of duplicates) {
    const same = cardOfIdentity.get(peer.identityId!)!
    cardOfPeer.set(peer.id, same)
    unlinkedPeers.push({ ...peer, sameAs: same.key })
  }

  const loose: K[] = []
  for (const key of keys) {
    const explicit = key.peerId ? cardOfPeer.get(key.peerId) : undefined
    if (explicit) {
      explicit.keys.push({ ...key, link: 'explicit' })
      continue
    }
    const byIdentity = key.boundIdentityId ? cardOfIdentity.get(key.boundIdentityId) : undefined
    if (byIdentity) {
      byIdentity.keys.push({ ...key, link: 'identity' })
      continue
    }
    loose.push(key)
  }

  const suggestPeer = (name: string | null) => peerCards.find(({ peer }) => namesMatch(peer.name, name))?.peer.id ?? null

  // A friend's keys without a peer: one card per bound identity, else per key.
  const keyCards = new Map<string, Friend<P, K>>()
  const unlinkedKeys: Array<K & { suggestedPeerId: string | null }> = []
  for (const key of loose) {
    if (!belongsToFriend(key)) {
      unlinkedKeys.push({ ...key, suggestedPeerId: suggestPeer(key.name) })
      continue
    }
    const cardKey = key.boundIdentityId ? `identity:${key.boundIdentityId}` : `key:${key.id}`
    let card = keyCards.get(cardKey)
    if (!card) {
      card = { key: cardKey, name: key.name?.trim() || 'Unnamed key', peer: null, keys: [], state: 'noPeer', suggestedKeyIds: [], suggestedPeerId: suggestPeer(key.name) }
      keyCards.set(cardKey, card)
      cards.push(card)
    }
    card.keys.push({ ...key, link: null })
  }

  const adopted = adoptByName(peers, peerCards, keyCards, cards, options.identityPending ?? (() => false))

  for (const { card, peer } of peerCards)
    card.suggestedKeyIds = loose.filter(key => !adopted.has(key.id) && namesMatch(peer.name, key.name)).map(key => key.id)

  for (const card of cards)
    card.state = friendState(card.peer, card.keys, now)

  cards.sort((a, b) => FRIEND_STATES.indexOf(a.state) - FRIEND_STATES.indexOf(b.state) || a.name.localeCompare(b.name))
  return { friends: cards, unlinked: { peers: unlinkedPeers, keys: unlinkedKeys } }
}

/**
 * A peer whose jack hasn't reported its identity yet (it was down since jack
 * started keeping identities, after an update say) takes the keys of one
 * identity card when the names match and nothing else does on either side:
 * that peer matches only this card, and this card only that peer. Every peer
 * counts for the second part, also one that reported an identity or is a second
 * peer of a jack: a name two peers share could be either of them. A peer that
 * is online and still reports no identity is left alone, since its jack would
 * have reported the one these keys are bound to, unless jack hasn't asked it
 * since it came back (`identityPending`). Once the peer reports its identity,
 * the identity link decides. Removes the adopted cards from `cards` and returns
 * the ids of the keys it moved.
 */
function adoptByName<P extends LinkablePeer, K extends LinkableKey>(
  peers: ReadonlyArray<P>,
  peerCards: Array<{ card: Friend<P, K>, peer: P }>,
  keyCards: Map<string, Friend<P, K>>,
  cards: Array<Friend<P, K>>,
  identityPending: (peerId: string) => boolean,
): Set<number> {
  const adopted = new Set<number>()
  const unknown = peerCards.filter(({ peer }) => peer.identityId == null && (peer.online !== true || identityPending(peer.id)))
  const identityCards = [...keyCards.values()].filter(card => card.key.startsWith('identity:'))
  const matches = (peer: P, card: Friend<P, K>) => card.keys.some(key => namesMatch(peer.name, key.name))
  for (const { card, peer } of unknown) {
    const [only, ...others] = identityCards.filter(keyCard => matches(peer, keyCard))
    if (!only || others.length > 0 || peers.some(other => other !== peer && matches(other, only)))
      continue
    card.keys.push(...only.keys.map(key => ({ ...key, link: 'identity' as const })))
    cards.splice(cards.indexOf(only), 1)
    for (const key of only.keys)
      adopted.add(key.id)
  }
  return adopted
}
