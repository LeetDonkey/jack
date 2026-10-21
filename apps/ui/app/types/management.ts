export interface ConnectorBase {
  id: string
  name: string
  url: string
  type: string
  initialized: boolean
  initializationError: string | null
  // Refs-intact secrets from GET /config — present only on a deployment with a
  // ConfigService (read-only deployments omit them). Values are never resolved:
  // a `{env}`/`{file}` ref comes back as the ref, a literal as its stored string.
  apiKey?: SecretRef
  headers?: Record<string, SecretRef>
}

export interface PeerItem extends ConnectorBase {
  version: string | null
}

// Why a call to a friend's jack failed (lib/net/peer-errors.ts on the backend).
export type PeerErrorCode = 'timeout' | 'dns' | 'refused' | 'tls' | 'unauthorized' | 'forbidden' | 'incompatible' | 'unavailable' | 'unknown'

// The health check of a friend's jack (every 5 minutes, after a save, and on POST /friends/check).
export interface PeerHealth {
  // Null before the first check.
  online: boolean | null
  offlineSince: string | null
  lastSeenAt: string | null
  lastError: string | null
  lastErrorCode: PeerErrorCode | null
  checkedAt: string | null
}

// The build a jack reports (git revision and build date); null fields on a build without them.
export interface BuildIdentity {
  revision: string | null
  buildDate: string | null
}

// One step of jack registering itself in a Radarr/Sonarr (registration.schema.ts).
export interface RegistrationStep {
  status: 'ok' | 'failed' | 'skipped'
  // What the *arr (or the network) reported, on 'failed'.
  error?: string
  // On 'skipped': no downloads block, or (indexer only) the download client step failed.
  reason?: 'downloads-off' | 'client-failed'
  // Indexer only, with downloads off: jack turned off a Jack indexer an earlier jack added.
  disabledUnbound?: true
}

export type RegistrationTest = 'ok' | 'failed' | 'skipped'

// What jack registered in one Radarr/Sonarr at its last registration this boot,
// with that *arr's own Test results for jack's client and indexer.
export interface DestinationRegistration {
  at: string
  indexer: RegistrationStep
  downloadClient: RegistrationStep
  reason?: 'downloads-off'
  clientTest: RegistrationTest
  indexerTest: RegistrationTest
  // Plain-language text about the first failed test, failed step or skip.
  message: string | null
  testErrors: { downloadClient: string | null, indexer: string | null }
  // The *arr skips jack's indexer after failures until this time; null when it
  // doesn't, or when it doesn't say until when (Radarr and Sonarr don't).
  indexerPausedUntil: string | null
  // Whether the *arr skips jack's indexer after failures, as jack last saw it
  // (after each registration, then every few minutes). Null when jack couldn't
  // tell, or didn't add the indexer.
  indexerPaused: boolean | null
}

// Every server entry in /config/servers and /overview carries these.
export interface ServerRegistrationFields {
  // Null before the first registration this boot, and for a server jack doesn't register itself in.
  registration: DestinationRegistration | null
  // When this *arr last authenticated with the key jack gave it (Torznab or qBittorrent). Null until it happens this boot.
  lastContactAt: string | null
}

// POST/PATCH /config/servers and POST /config/servers/:id/register.
export interface ServerSaveResponse {
  ok: true
  // Null when the server isn't an auto-register destination, or while registrationPending.
  registration: DestinationRegistration | null
  // True when registration took over 25 s; the result then arrives on the streams.
  registrationPending: boolean
}

export interface ServerItem extends ConnectorBase, ServerRegistrationFields {
  source: boolean
  destination: boolean
  autoregister: { enable: boolean, priority: number }
  // Whether friends' releases are offered for items this *arr already has.
  upgrades: { allow: boolean, maxSizeGiB: number | null }
}

// The /overview endpoint returns connector items WITHOUT autoregister (that field
// only comes back on the full /config/servers payload). Keep the type honest so
// nothing reaches for a field the overview never sends.
export type OverviewServerItem = Omit<ServerItem, 'autoregister' | 'upgrades'>

// Settings saved since jack started that only apply after a restart of the jack container.
export type RestartReason = 'downloads' | 'downloads.completedPath' | 'downloads.retries' | 'downloads.import' | 'jack.tmdbApiKey' | 'jack.apiKey'

export interface SystemStatus {
  // When this jack process started. A new value means jack restarted.
  bootedAt: string
  restartPending: RestartReason[]
  // One-time notices for this install, until dismissed (POST system/notices/:id/dismiss).
  notices: SystemNotice[]
}

// Settings whose default changed in an update. Listed only for installs that
// existed before the update and only while the value still comes from the
// default (saving the setting removes it from the list).
export type ChangedDefaultSetting = 'discovery.introduce' | 'security.banEnabled' | 'security.lanOnlyArrApis' | 'security.publicOpenApi'

export interface SystemNotice {
  id: string
  kind: 'defaultsChanged'
  changed: Array<{ setting: ChangedDefaultSetting, was: boolean, now: boolean }>
}

export interface DownloadItem {
  id: number
  filename: string
  peerName: string
  peerId: string
  status: 'downloading' | 'import_queued' | 'imported' | 'failed'
  downloadedBytes: number
  totalBytes: number | null
  progress: number | null
  releaseSize: number
  attempts: number
  error: string | null
  lastOperation: 'transfer' | 'import'
  operationFailed: boolean
  importMode: 'jack_manual' | null
  importTarget: { kind: 'movie', movieId: number } | { kind: 'series', seriesId: number } | null
  startedAt: string
  updatedAt: string
  completedAt: string | null
  expectedBytesMismatch: boolean
}

export interface TmdbMetadata {
  tmdbId: number
  title: string
  overview: string | null
  year: number | null
  rating: number | null
  posterUrl: string | null
  backdropUrl: string | null
  genres: string[]
}

export interface CatalogRelease {
  id: string
  title: string
  filename: string
  size: number
  quality?: { name?: string, source?: string, resolution?: number }
  season?: number
  episode?: number
}

export interface CatalogTitlePeer {
  id: string
  name: string
  releaseCount: number
  totalSize: number
  releases: CatalogRelease[]
}

export interface CatalogTitle {
  key: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  imdbId?: string
  tvdbId?: number
  displayTitle: string
  // Totals across every peer that carries this title.
  releaseCount: number
  totalSize: number
  metadata?: TmdbMetadata | null
  quality?: string
  peers: CatalogTitlePeer[]
}

export interface CatalogResponse {
  peers: Array<{ id: string, name: string }>
  titles: CatalogTitle[]
  updatedAt?: string | null
}

export interface RequestServerOption {
  id: string
  name: string
  type: 'radarr' | 'sonarr'
  mediaType: 'movie' | 'tv'
  rootFolders: Array<{ path: string, freeSpace?: number }>
}

export interface CatalogRequestPayload {
  peerId: string
  serverId: string
  rootFolderPath: string
}

export interface Overview {
  peers: { total: number, initialized: number, items: PeerItem[] }
  servers: { total: number, initialized: number, sources: number, destinations: number, items: OverviewServerItem[] }
  system: SystemStatus
  downloads: {
    total: number
    byStatus: Record<string, number>
    bytesMoved: number
    mismatched: number
    active: DownloadItem[]
    importQueued: DownloadItem[]
    failed: DownloadItem[]
  }
}

// Secret refs mirror the backend's RawConfigSecret union.
export type SecretRef = string | { env: string } | { file: string }

export interface PeerInput {
  name: string
  url: string
  apiKey: SecretRef
  headers?: Record<string, SecretRef>
}

export interface ServerInput {
  name: string
  url: string
  apiKey: SecretRef
  type: 'radarr' | 'sonarr'
  source?: boolean
  destination?: boolean
  headers?: Record<string, SecretRef>
  autoregister?: { enable?: boolean, priority?: number }
  upgrades?: { allow?: boolean, maxSizeGiB?: number | null }
}

// config.jack: internalUrl + optional secrets and the external access profile.
export interface ExternalJackConfig {
  instanceName?: string
  url: string
  headers?: Record<string, SecretRef>
}

export interface JackConfig {
  internalUrl: string
  apiKey?: SecretRef | null
  tmdbApiKey?: SecretRef | null
  external?: ExternalJackConfig
}

// config.downloads, exactly as persisted (null when the block is absent — downloads
// are not configured). Every field is optional: a PATCH is merged onto the stored
// block, so the UI only sends what it edits.
export interface DownloadsConfig {
  completedPath?: string
  maxConcurrentDownloads?: number
  maxDownloadAttempts?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  retryWindowMs?: number
  idleTimeoutMs?: number
  importPollIntervalMs?: number
  maxManualImportAttempts?: number
  manualImportBackoffBaseMs?: number
  manualImportBackoffMaxMs?: number
  unlinkImportedFiles?: boolean
}

// PATCH body for config.downloads. Absent leaves the stored value alone; `null` drops
// the key from the file so jack's default applies again (how the UI clears a field).
// `completedPath` has no default, so it can't be cleared.
export type DownloadsConfigPatch
  = & { completedPath?: string }
    & { [K in Exclude<keyof DownloadsConfig, 'completedPath'>]?: DownloadsConfig[K] | null }

// How jack came to make a key: a quick link, an introduction, or by hand (null).
export type ApiKeyOrigin = 'quick-link' | 'introduction'

export interface ApiKey {
  id: number
  name: string | null
  description: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  // When a friend's jack last used the key (to the minute). Null means not since
  // `lastUsedTrackedSince`: the key's creation, or for an older key the day jack
  // started recording last use.
  lastUsedAt: string | null
  lastUsedTrackedSince: string
  // The peer (same friend) the key is linked to.
  peerId: string | null
  origin: ApiKeyOrigin | null
  // The jack identity that used the key for friends-of-friends mail.
  boundIdentityId: string | null
}

// POST /api-keys returns the raw key exactly once; every later read omits it.
export interface CreatedApiKey extends ApiKey {
  key: string
}

export interface ApiKeyInput {
  name?: string | null
  description?: string | null
  expiresAt?: string | null
  // PATCH only: link the key to a peer, or `null` to unlink it.
  peerId?: string | null
}

export interface QuickLinkInput {
  peerName: string
  keyName: string
  keyDescription?: string | null
  expiresAt?: string | null
  // The peer the new key belongs to (a friend you already download from).
  peerId?: string | null
  // "Send a new link": the key this link replaces. jack revokes it when it was never used.
  replaceKeyId?: number | null
}

// What POST /quick-links did with the key named by `replaceKeyId`.
export interface ReplacedKey {
  keyId: number
  // True when jack revoked the old key (never used, no identity bound to it).
  revoked: boolean
  // Why it was kept: used, bound to a jack identity, or older than usage tracking. Null when revoked.
  keptBecause: 'used' | 'bound' | 'unknown' | null
  lastUsedAt: string | null
  lastUsedTrackedSince: string
}

export interface CreatedQuickLink {
  link: string
  key: ApiKey
  // Null unless the request named `replaceKeyId`.
  replaced: ReplacedKey | null
}

// ── Management API errors ──────────────────────────────────────────────────

export interface ValidationIssue {
  // Dotted path of the field (`url`, `schedule.0.days`), or null for the body as a whole.
  field: string | null
  message: string
}

// The `error` of a failed management call. A validation failure (400) has
// `code: 'VALIDATION_ERROR'` with `field` and `issues`; a peer that failed its
// handshake on save (502) has `code: 'CONNECTOR_INITIALIZATION_FAILED'` with
// `reason` and `upstreamStatus`.
export interface ManagementErrorBody {
  code?: string
  message?: string
  field?: string | null
  issues?: ValidationIssue[]
  reason?: PeerErrorCode
  upstreamStatus?: number | null
}

// One NDJSON log line as served by GET /logs and the /logs/stream SSE. `time` is
// epoch millis, `level` the pino numeric level, `severity` its label; anything
// else (trace_id, request fields, …) rides along as extra keys.
export interface LogRecord {
  time?: number
  level?: number
  severity?: string
  message?: string
  trace_id?: string
  [key: string]: unknown
}

// ── Transfers & bandwidth ───────────────────────────────────────────────────

export type TransferDirection = 'download' | 'upload'

export interface TransferInfo {
  id: string
  direction: TransferDirection
  peer: string
  filename: string
  totalBytes: number | null
  transferredBytes: number
  bytesPerSecond: number
  etaSeconds: number | null
  startedAt: string
}

export interface TransferDirectionSummary {
  active: number
  maxConcurrent: number | null
  bytesPerSecond: number
  limitBytesPerSecond: number | null
}

export interface TransfersSnapshot {
  download: TransferDirectionSummary
  upload: TransferDirectionSummary
  schedulePeriod: number | null
  transfers: TransferInfo[]
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface BandwidthPeriod {
  days: Weekday[]
  start: string
  end: string
  downloadLimitKiBps?: number | null
  uploadLimitKiBps?: number | null
}

export interface BandwidthConfig {
  downloadLimitKiBps?: number | null
  uploadLimitKiBps?: number | null
  maxConcurrentUploads?: number | null
  maxConcurrentUploadsPerPeer?: number | null
  dailyUploadLimitGiBPerPeer?: number | null
  schedule: BandwidthPeriod[]
}

export type BandwidthConfigPatch = Partial<Omit<BandwidthConfig, 'schedule'>> & { schedule?: BandwidthPeriod[] | null }

// config.torznab with defaults applied (GET), and its PATCH body (`null` restores a default).
export interface TorznabConfig {
  rssMaxAgeDays: number
  rssMaxItems: number
}

export type TorznabConfigPatch = { [K in keyof TorznabConfig]?: TorznabConfig[K] | null }

// GET /friends: reachability and traffic per friend, both directions.
export interface TrafficWindow {
  today: number
  week: number
  month: number
}

// "You download from Alice": a peer, with its health check.
export interface FriendPeer extends PeerHealth {
  id: string
  name: string
  url: string
  version: string | null
  build: BuildIdentity | null
  downloaded: TrafficWindow
  // The jack identity the peer reports (kept while it is down); null when it never did.
  identityId: string | null
}

// "Alice downloads from you": a key you issued.
export interface FriendKey {
  id: number
  name: string | null
  expiresAt: string | null
  activeUploads: number
  uploaded: TrafficWindow
  lastUsedAt: string | null
  lastUsedTrackedSince: string
  peerId: string | null
  origin: ApiKeyOrigin | null
  boundIdentityId: string | null
  boundAt: string | null
}

// In the order the backend sorts cards: the states that need action first.
// `stale`: a key was used before, but none in the last 24 hours.
// `waiting`: no key was ever used.
export type FriendState = 'offline' | 'noKey' | 'noPeer' | 'stale' | 'waiting' | 'both'

// One person: the peer you download from and the keys they download from you with.
export interface Friend {
  // Stable card id: `peer:<id>`, or without a peer `identity:<id>` / `key:<id>`.
  key: string
  name: string
  peer: FriendPeer | null
  // `link`: how the key joined the peer (its peerId, or its bound identity); null on a card without a peer.
  keys: Array<FriendKey & { link: 'explicit' | 'identity' | null }>
  state: FriendState
  // Keys on no peer's card whose name matches this peer's. A suggestion, never applied.
  suggestedKeyIds: number[]
  // On a card without a peer: a peer whose name matches. A suggestion, never applied.
  suggestedPeerId: string | null
}

export interface FriendsLimits {
  maxConcurrentUploadsPerPeer: number | null
  dailyUploadLimitGiBPerPeer: number | null
}

export interface FriendsSnapshot {
  peers: FriendPeer[]
  keys: FriendKey[]
  limits: FriendsLimits
  friends: Friend[]
  unlinked: {
    // A second peer for a jack identity that already has a card (`sameAs` is that card's key).
    peers: Array<FriendPeer & { sameAs: string }>
    // Keys that belong to no friend: API keys for other tools.
    keys: Array<FriendKey & { suggestedPeerId: string | null }>
  }
}

// config.notifications as stored (webhook URLs may be {env}/{file} references).
export interface NotificationWebhook {
  type: 'discord' | 'ntfy' | 'json'
  url: SecretRef
}

export interface NotificationsConfig {
  webhooks?: NotificationWebhook[] | null
  downloadFailed?: boolean | null
  peerOffline?: boolean | null
  peerOfflineMinutes?: number | null
  ipBanned?: boolean | null
  dailySummaryAt?: string | null
}

// config.discovery with defaults applied.
export interface DiscoveryConfig {
  publicName?: string | null
  discoverable: boolean
  introduce: boolean
}

export type DiscoveryConfigPatch = { [K in keyof DiscoveryConfig]?: DiscoveryConfig[K] | null }

// GET /introductions
export interface IntroThreadMessage {
  from: 'me' | 'them' | 'system'
  text: string
  at: string
}

export interface IntroThread {
  requestId: string
  direction: 'outgoing' | 'incoming'
  peerId: string
  peerName: string
  viaName: string
  state: 'pending' | 'accepted' | 'connected' | 'declined'
  messages: IntroThreadMessage[]
  safetyCode: string
  createdAt: string
  updatedAt: string
  // A connected thread whose person is no longer one of your peers; you can ask again.
  ended: boolean
}

export interface IntroPerson {
  id: string
  name: string
  via: Array<{ peerId: string, name: string }>
  status: 'available' | 'requested' | 'connected'
}

export interface IntroductionsOverview {
  // introducers: friends whose jack introduced you at the last sync (they have
  // "Introduce my friends" on); null before the first sync.
  me: { id: string, name: string | null, discoverable: boolean, introduce: boolean, ready: boolean, missing: string[], introducers: number | null }
  people: IntroPerson[]
  threads: IntroThread[]
}

// config.security with defaults applied.
export interface SecurityConfig {
  banEnabled: boolean
  maxFailures: number
  windowMinutes: number
  banMinutes: number
  trustedProxies?: string[] | null
  neverBan?: string[] | null
  lanOnlyArrApis: boolean
  arrApiAlsoAllowed?: string[] | null
  publicOpenApi: boolean
}

export type SecurityConfigPatch = { [K in keyof SecurityConfig]?: SecurityConfig[K] | null }

// GET config/security: the effective config plus stored address entries that
// jack ignores because they aren't an IP address or CIDR range. The next save
// of the security block drops them from config.jsonc.
export interface SecurityConfigResponse extends SecurityConfig {
  ignoredEntries: Array<{ field: 'trustedProxies' | 'neverBan' | 'arrApiAlsoAllowed', value: string }>
}

// GET /security/bans
export interface BanEntry {
  ip: string
  bannedAt: string
  bannedUntil: string
  failures: number
  reason: string
}

export interface BansSnapshot {
  bans: BanEntry[]
  failing: Array<{ ip: string, failures: number, lastAt: string }>
}
