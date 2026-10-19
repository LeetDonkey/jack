import { z } from 'zod'
import { API_KEY_ORIGINS } from '../api-keys/api-key-meta'
import { BuildIdentitySchema, PeerHealthSchema } from '../status/status.schema'
import { FRIEND_STATES } from './friend-links'

// Response shape of GET /friends and POST /friends/check, for the OpenAPI docs
// (see FriendsSnapshot in friends.router.ts).

const TrafficWindowSchema = z.object({
  today: z.number(),
  week: z.number().describe('The last 7 days'),
  month: z.number().describe('The last 30 days'),
}).describe('Bytes per window (server time)')

export const FriendPeerSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  version: z.string().nullable().describe('The jack version the peer last reported'),
  build: BuildIdentitySchema.nullable().describe('The build (git revision and date) the peer reported in its last handshake; null when it reports none'),
})
  .extend(PeerHealthSchema.shape)
  .extend({
    downloaded: TrafficWindowSchema,
    identityId: z.string().nullable().describe('The jack identity the peer reports (or last reported, while it is down); null when it never did'),
  })

export const FriendKeySchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  expiresAt: z.string().nullable(),
  activeUploads: z.number(),
  uploaded: TrafficWindowSchema,
  lastUsedAt: z.string().nullable().describe('When a friend\'s jack last authenticated with this key (to the minute); null when not since `lastUsedTrackedSince`'),
  lastUsedTrackedSince: z.string().describe('When `lastUsedAt` starts to count: the key\'s creation, or the start of usage tracking for an older key'),
  peerId: z.string().nullable().describe('The peer this key is explicitly linked to'),
  origin: z.enum(API_KEY_ORIGINS).nullable(),
  boundIdentityId: z.string().nullable().describe('The jack identity that used this key for friends-of-friends mail'),
  boundAt: z.string().nullable(),
})

export const FriendSchema = z.object({
  key: z.string().describe('Stable card id: `peer:<peer id>`, or for a friend without a peer `identity:<identity id>` or `key:<key id>`'),
  name: z.string(),
  peer: FriendPeerSchema.nullable(),
  keys: z.array(FriendKeySchema.extend({
    link: z.enum(['explicit', 'identity']).nullable().describe('How the key joined the peer: its `peerId`, or its bound identity (for a peer that never reported one: its name, see the route description). Null on a card without a peer'),
  })),
  state: z.enum(FRIEND_STATES),
  suggestedKeyIds: z.array(z.number()).describe('Keys on no peer\'s card whose name matches this peer\'s. Never applied'),
  suggestedPeerId: z.string().nullable().describe('For a card without a peer: a peer whose name matches. Never applied'),
})

export const FriendsSnapshotSchema = z.object({
  peers: z.array(FriendPeerSchema),
  keys: z.array(FriendKeySchema),
  limits: z.object({
    maxConcurrentUploadsPerPeer: z.number().nullable(),
    dailyUploadLimitGiBPerPeer: z.number().nullable(),
  }),
  friends: z.array(FriendSchema),
  unlinked: z.object({
    peers: z.array(FriendPeerSchema.extend({ sameAs: z.string().describe('The key of the card that shows this jack') })),
    keys: z.array(FriendKeySchema.extend({ suggestedPeerId: z.string().nullable() })),
  }),
})
