import type { BandwidthConfig } from '../../lib/config'
import type { ApiKeyMeta, ApiKeyOrigin } from '../api-keys/api-key-meta'
import type { KeyBinding } from '../api-keys/api-keys.controller'
import type { ApiKeysRepository } from '../api-keys/api-keys.repository'
import type { TrafficLedger } from '../transfers/traffic-ledger'
import type { TransferMonitor } from '../transfers/transfer-monitor'
import type { FriendLinks } from './friend-links'
import type { PeerHealth, PeerHealthMonitor } from './peer-health'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { lastUsedTrackedSince } from '../api-keys/api-key-meta'
import { localDay } from '../transfers/traffic-ledger'
import { linkFriends } from './friend-links'
import { FriendsSnapshotSchema } from './friends.schema'

export interface TrafficWindow {
  today: number
  week: number
  month: number
}

export type FriendPeer = PeerHealth & {
  downloaded: TrafficWindow
  /** The jack identity the peer reports (fork jacks, learnt by the introduction sync); null when unknown. */
  identityId: string | null
}

export interface FriendKey {
  id: number
  name: string | null
  expiresAt: string | null
  activeUploads: number
  uploaded: TrafficWindow
  /** When a friend's jack last authenticated with this key (to the minute); null when not since `lastUsedTrackedSince`. */
  lastUsedAt: string | null
  /** When `lastUsedAt` starts to count: the key's creation, or the start of usage tracking for an older key. */
  lastUsedTrackedSince: string
  /** The peer this key is explicitly linked to; null when not linked by hand, quick link or introduction. */
  peerId: string | null
  origin: ApiKeyOrigin | null
  /** The jack identity that used this key for introduction mail; null when none did. */
  boundIdentityId: string | null
  boundAt: string | null
}

/** `friends` and `unlinked` put each person's peer and keys together (see friend-links.ts). */
export interface FriendsSnapshot extends FriendLinks<FriendPeer, FriendKey> {
  /** Friends you download from (the peers in your config). */
  peers: FriendPeer[]
  /** Friends who download from you (the API keys you issued). */
  keys: FriendKey[]
  limits: { maxConcurrentUploadsPerPeer: number | null, dailyUploadLimitGiBPerPeer: number | null }
}

export interface FriendsDeps {
  health: Pick<PeerHealthMonitor, 'list'>
  ledger?: Pick<TrafficLedger, 'totalsSince'>
  monitor?: Pick<TransferMonitor, 'activeCount'>
  apiKeys?: Pick<ApiKeysRepository, 'list'>
  /** Last use, explicit peer link and origin of each key. */
  keyMeta?: Pick<ApiKeyMeta, 'all'> & Partial<Pick<ApiKeyMeta, 'trackingSince'>>
  /** Jack identities of peers and keys (from introductions). */
  identities?: { peerIdentity: (peerId: string) => string | null, keyBindings: () => KeyBinding[], identityPending?: (peerId: string) => boolean }
  bandwidth: () => BandwidthConfig | undefined
  now?: () => Date
}

export function friendsSnapshot(deps: FriendsDeps): FriendsSnapshot {
  const now = (deps.now ?? (() => new Date()))()
  const daysAgo = (days: number) => localDay(new Date(now.getTime() - days * 86_400_000))
  const windows = { today: daysAgo(0), week: daysAgo(6), month: daysAgo(29) }
  const totals = Object.fromEntries(Object.entries(windows).map(([name, from]) => [name, deps.ledger?.totalsSince(from) ?? []])) as Record<keyof TrafficWindow, ReturnType<TrafficLedger['totalsSince']>>
  const traffic = (direction: 'in' | 'out', party: string): TrafficWindow => ({
    today: totals.today.find(t => t.direction === direction && t.party === party)?.bytes ?? 0,
    week: totals.week.find(t => t.direction === direction && t.party === party)?.bytes ?? 0,
    month: totals.month.find(t => t.direction === direction && t.party === party)?.bytes ?? 0,
  })
  const bandwidth = deps.bandwidth()
  const meta = deps.keyMeta?.all()
  const trackingSince = deps.keyMeta?.trackingSince?.() ?? null
  const bindings = new Map((deps.identities?.keyBindings() ?? []).map(b => [b.apiKeyId, b]))

  const peers: FriendPeer[] = deps.health.list().map(peer => ({
    ...peer,
    downloaded: traffic('in', `peer:${peer.id}`),
    identityId: deps.identities?.peerIdentity(peer.id) ?? null,
  }))
  const keys: FriendKey[] = (deps.apiKeys?.list() ?? []).map(key => ({
    id: key.id,
    name: key.name,
    expiresAt: key.expiresAt,
    activeUploads: deps.monitor?.activeCount('upload', `key:${key.id}`) ?? 0,
    uploaded: traffic('out', `key:${key.id}`),
    lastUsedAt: meta?.get(key.id)?.lastUsedAt ?? null,
    lastUsedTrackedSince: lastUsedTrackedSince(key.createdAt, trackingSince),
    peerId: meta?.get(key.id)?.peerId ?? null,
    origin: meta?.get(key.id)?.origin ?? null,
    boundIdentityId: bindings.get(key.id)?.identityId ?? null,
    boundAt: bindings.get(key.id)?.boundAt ?? null,
  }))

  return {
    peers,
    keys,
    limits: {
      maxConcurrentUploadsPerPeer: bandwidth?.maxConcurrentUploadsPerPeer ?? null,
      dailyUploadLimitGiBPerPeer: bandwidth?.dailyUploadLimitGiBPerPeer ?? null,
    },
    ...linkFriends(peers, keys, now, { identityPending: peerId => deps.identities?.identityPending?.(peerId) ?? false }),
  }
}

const SNAPSHOT_DOC = [
  'Every peer you download from, with its health check (`online`, `offlineSince`, `lastSeenAt`, `lastError`, `lastErrorCode`), version, the jack `identityId` it reports (kept from its last answer while it is down) and bytes downloaded, and every API key you issued, with bytes uploaded to it, `lastUsedAt`, `lastUsedTrackedSince`, its explicit `peerId` link, `origin`, `boundIdentityId` and `boundAt`. Traffic windows are today, the last 7 days and the last 30 days (server time). A null `lastUsedAt` means the key wasn\'t used since `lastUsedTrackedSince`: its creation, or for a key made before jack recorded last use, the start of that.',
  '`friends` puts both halves of each person together: `{ key, name, peer, keys, state, suggestedKeyIds, suggestedPeerId }`. A key joins a peer when its `peerId` names that peer (`link: "explicit"`), else when its bound identity equals the peer\'s `identityId` (`link: "identity"`). A peer that never reported an identity, and is not online or has not answered about its identity since jack started, also takes the keys bound to one identity no card has, when a key name matches that peer and no other peer (also counting peers that reported an identity), and no other identity\'s keys match it (`link: "identity"`); its own identity decides once it reports one. Otherwise names never link; a key on no peer\'s card whose name matches a peer\'s shows up in that peer\'s `suggestedKeyIds`, and a friend without a peer gets `suggestedPeerId`.',
  'Every peer has a card (`key` `peer:<id>`), except a second peer for the same jack identity. Keys made by a quick link or an introduction, or bound to an identity, without a peer get a card with `peer: null` (`identity:<id>` per identity, else `key:<id>`); their `link` is null.',
  '`state` is `offline` (the peer\'s last check failed), `noKey` (a peer but no key), `noPeer` (keys but no peer), `stale` (a peer and keys; a key was used before, but none in the last 24 hours), `waiting` (a peer and keys, none ever used) or `both` (a key used in the last 24 hours and the peer not offline); a peer not checked yet doesn\'t count as offline. Cards are sorted in that order, then by name.',
  '`unlinked.keys` are keys of no friend (API keys for other tools), each with `suggestedPeerId`. `unlinked.peers` are second peers for a jack identity that already has a card, each with `sameAs` (that card\'s key). The card shows the online peer of the two, else one not checked yet, else the one seen last.',
].join(' ')

export function getFriendsRouter(deps: FriendsDeps & { health: Pick<PeerHealthMonitor, 'list' | 'checkAll'> }) {
  const app = new Hono()
  app.get('/', describeRoute({
    tags: ['Friends'],
    summary: 'Friends overview',
    description: SNAPSHOT_DOC,
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Friends snapshot', content: { 'application/json': { schema: resolver(FriendsSnapshotSchema) } } } },
  }), c => c.json(friendsSnapshot(deps)))

  app.post('/check', describeRoute({
    tags: ['Friends'],
    summary: 'Check every friend now',
    description: 'Runs the peer health check (a handshake with every peer) now instead of waiting for the next 5-minute round, then answers with the same snapshot as `GET /friends`. A peer that doesn\'t answer holds the response until its request times out (HTTP_TIMEOUT_MS, 30 s by default). `/overview/stream` gets the new health too.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Friends snapshot after the check', content: { 'application/json': { schema: resolver(FriendsSnapshotSchema) } } } },
  }), async (c) => {
    await deps.health.checkAll()
    return c.json(friendsSnapshot(deps))
  })
  return app
}
