import type { Envs } from './envs'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { jsonc } from 'jsonc'
import z from 'zod'
import { logger } from '../logger'
import { atomicWriteFile } from './atomic-write'
import { isWritableDirectory } from './fs-checks'
import { isAddressOrRange } from './net/ip'

const TRAILING_LINE_ENDINGS = /[\r\n]+$/

/**
 * A secret value (API key, token, ...) that can be supplied in three ways:
 *
 * - as a plain string: `"my-secret"`
 * - as a reference to an environment variable: `{ "env": "MY_SECRET" }`
 * - as a reference to an absolute file path: `{ "file": "/run/secrets/my-secret" }`
 *
 * Whatever the input shape, the parsed value is always the resolved string, so
 * the rest of the codebase keeps reading `config.*.apiKey` as a plain string and
 * existing string-based configs keep working unchanged.
 *
 * @param value - schema used to validate the resolved string (defaults to a
 * non-empty string). It is applied both to literal strings and to values loaded
 * from the environment or filesystem
 */
export function ConfigSecret(value: z.ZodType<string, string> = z.string().min(1)) {
  return z
    .union([
      z.string(),
      z.object({ env: z.string().min(1) }),
      z.object({ file: z.string().min(1) }),
    ])
    .transform((input, ctx) => {
      if (typeof input === 'string')
        return input

      if ('env' in input) {
        const resolved = process.env[input.env]

        if (!resolved) {
          ctx.addIssue({
            code: 'custom',
            message: `Environment variable "${input.env}" is not set`,
            fatal: true,
          })
          return z.NEVER
        }

        return resolved
      }

      if (!isAbsolute(input.file)) {
        ctx.addIssue({
          code: 'custom',
          message: `Secret file path "${input.file}" must be absolute`,
          fatal: true,
        })
        return z.NEVER
      }

      try {
        return readFileSync(input.file, 'utf8').replace(TRAILING_LINE_ENDINGS, '')
      }
      catch {
        ctx.addIssue({
          code: 'custom',
          message: `Secret file "${input.file}" could not be read`,
          fatal: true,
        })
        return z.NEVER
      }
    })
    .pipe(value)
}

// Raw (ref-preserving) secret: the union BEFORE ConfigSecret resolves it. Used only
// for persistence so the versioned file keeps {env}/{file} refs. Declared up here so
// both RawPeerConfig (below) and RawServerConfig (Phase 5) can reference it.
export const RawConfigSecret = z.union([
  z.string(),
  z.object({ env: z.string().min(1) }),
  z.object({ file: z.string().min(1) }),
])

export const ServerType = z.enum(['radarr', 'sonarr'])

export type ServerType = z.infer<typeof ServerType>

export type ConnectorType = ServerType | 'jack'

export const ConnectorHeadersConfig = z.record(z.string(), ConfigSecret()).default({})

export type ConnectorHeadersConfig = z.infer<typeof ConnectorHeadersConfig>

export const AutoRegisterConfig = z.object({
  enable: z.boolean().default(true),
  // 1 is the most preferred indexer, 50 the least: with 50, the *arr's other
  // indexers win when two releases are otherwise equal.
  priority: z.number().int().min(1).default(50),
})

export type AutoRegisterConfig = z.infer<typeof AutoRegisterConfig>

// Whether jack offers peer releases for items this *arr already has a file for.
// `allow: false` offers only what is missing; `maxSizeGiB` lets an upgrade
// through only up to that size. Missing items are always offered.
export const UpgradePolicyConfig = z.object({
  allow: z.boolean().default(true),
  maxSizeGiB: z.number().positive().nullish(),
})

export type UpgradePolicyConfig = z.infer<typeof UpgradePolicyConfig>

export const ServerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: ConfigSecret(z.hex().min(32).max(32)),
  headers: ConnectorHeadersConfig,
  type: ServerType,
  source: z.boolean().default(true),
  destination: z.boolean().default(true),
  autoregister: AutoRegisterConfig.prefault({}),
  upgrades: UpgradePolicyConfig.prefault({}),
})

export type ServerConfig = z.infer<typeof ServerConfig>

// Raw server for persistence: strip unknown keys from a management-client body while
// preserving {env}/{file} secret refs, mirroring RawPeerConfig.
export const RawServerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: RawConfigSecret,
  headers: z.record(z.string(), RawConfigSecret).optional(),
  type: ServerType,
  source: z.boolean().optional(),
  destination: z.boolean().optional(),
  autoregister: z.object({ enable: z.boolean().optional(), priority: z.number().int().min(1).max(50).optional() }).optional(),
  upgrades: z.object({ allow: z.boolean().optional(), maxSizeGiB: z.number().positive().nullish() }).optional(),
})

export type RawServerConfig = z.infer<typeof RawServerConfig>

export const PeerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: ConfigSecret(),
  headers: ConnectorHeadersConfig,
})

export type PeerConfig = z.infer<typeof PeerConfig>

// Raw peer for persistence: declares exactly the fields we store, so unknown keys
// from a management-client body are stripped before they reach the file.
export const RawPeerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: RawConfigSecret,
  headers: z.record(z.string(), RawConfigSecret).optional(),
})

export type RawPeerConfig = z.infer<typeof RawPeerConfig>

const RESERVED_EXTERNAL_HEADERS = new Set([
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
])
const DANGEROUS_EXTERNAL_HEADER_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const HTTP_HEADER_LINE_BREAK = /[\r\n]/

const ExternalHeaderName = z.string()
  .trim()
  .min(1)
  .regex(/^[!#$%&'*+\-.^`|~\w]+$/, 'Invalid HTTP header name')
  .refine(name => !DANGEROUS_EXTERNAL_HEADER_NAMES.has(name.toLowerCase()), 'Dangerous HTTP header name')
  .refine(name => !RESERVED_EXTERNAL_HEADERS.has(name.toLowerCase()), 'Reserved HTTP header')

const ExternalHeaderValue = z.string()
  .min(1)
  .refine(value => !HTTP_HEADER_LINE_BREAK.test(value), 'HTTP header values cannot contain line breaks')

const ExternalJackUrl = z.url().refine((value) => {
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && !url.username
    && !url.password
}, 'Use an http:// or https:// address without a username or password in it.')

// Inspect raw keys before z.record builds its output object. In particular,
// assigning `__proto__` onto a normal object can otherwise mutate its prototype
// instead of surviving as an own key for the key schema to validate.
const ExternalHeadersObject = z.unknown().superRefine((headers, ctx) => {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers))
    return
  const normalizedNames = new Set<string>()
  for (const name of Object.keys(headers)) {
    const normalizedName = name.toLowerCase()
    if (DANGEROUS_EXTERNAL_HEADER_NAMES.has(normalizedName))
      ctx.addIssue({ code: 'custom', message: 'Dangerous HTTP header name' })
    if (normalizedNames.has(normalizedName))
      ctx.addIssue({ code: 'custom', message: 'Duplicate HTTP header name' })
    normalizedNames.add(normalizedName)
  }
})

const ResolvedExternalHeaders = ExternalHeadersObject.pipe(z.record(ExternalHeaderName, ConfigSecret(ExternalHeaderValue)))
  .refine(headers => Object.keys(headers).length <= 100, 'At most 100 external headers are allowed')

const RawExternalHeaders = ExternalHeadersObject.pipe(z.record(ExternalHeaderName, RawConfigSecret))
  .refine(headers => Object.keys(headers).length <= 100, 'At most 100 external headers are allowed')

export const ExternalJackConfig = z.object({
  instanceName: z.string().trim().min(1).max(100).optional(),
  url: ExternalJackUrl,
  headers: ResolvedExternalHeaders.default({}),
})

export type ExternalJackConfig = z.infer<typeof ExternalJackConfig>

export const RawExternalJackConfig = z.object({
  instanceName: z.string().trim().min(1).max(100).optional(),
  url: ExternalJackUrl,
  headers: RawExternalHeaders.optional(),
})

export type RawExternalJackConfig = z.infer<typeof RawExternalJackConfig>

export const JackConfig = z.object({
  internalUrl: z.url(),
  // The single "Main API key" (deprecated). Optional: a jack block can carry
  // only an internalUrl, in which case the public API authenticates via generated
  // keys (see require-auth.ts), not this key.
  apiKey: ConfigSecret().optional(),
  // Optional TMDB v3 API key for enriching peer catalogs with artwork/metadata.
  tmdbApiKey: ConfigSecret().optional(),
  // How another Jack reaches this instance. Header secrets resolve only when a
  // quick link is generated; raw refs remain intact in the persisted config.
  external: ExternalJackConfig.optional(),
})

export type JackConfig = z.infer<typeof JackConfig>

// Raw jack for persistence: preserve {env}/{file} secret refs and the optional
// apiKey, mirroring RawPeerConfig/RawServerConfig.
export const RawJackConfig = z.object({
  internalUrl: z.url(),
  apiKey: RawConfigSecret.optional(),
  tmdbApiKey: RawConfigSecret.optional(),
  external: RawExternalJackConfig.optional(),
})

export type RawJackConfig = z.infer<typeof RawJackConfig>

// PATCH body for the jack block, merged onto the stored block: an absent key keeps
// its value and `null` removes it. `internalUrl` has no default, so it can't be
// removed (the same rule as downloads.completedPath).
export const RawJackConfigPatch = z.object({
  internalUrl: z.url().optional(),
  apiKey: RawConfigSecret.nullish(),
  tmdbApiKey: RawConfigSecret.nullish(),
  external: RawExternalJackConfig.nullish(),
})

export type RawJackConfigPatch = z.infer<typeof RawJackConfigPatch>

// Until when sharing (bandwidth.pausedUntil) or downloading (downloads.pausedUntil)
// is paused: an ISO 8601 time with a UTC offset, or 'indefinite' (until resumed).
// A time in the past means not paused. Set through POST /transfers/pause.
export const PAUSE_INDEFINITE = 'indefinite'
export const PausedUntil = z.union([z.literal(PAUSE_INDEFINITE), z.iso.datetime({ offset: true })])

export type PausedUntil = z.infer<typeof PausedUntil>

export const DownloadsConfig = z.object({
  completedPath: z.string().min(1),
  maxConcurrentDownloads: z.number().int().min(1).default(3),
  maxDownloadAttempts: z.number().int().min(1).default(13),
  retryBaseDelayMs: z.number().int().min(0).default(1000),
  retryMaxDelayMs: z.number().int().min(0).default(1_800_000),
  // A transient failure is retried past maxDownloadAttempts until this long has
  // passed since the download last received data, so a peer that is down for a
  // few hours does not fail the queue. 0 leaves only maxDownloadAttempts.
  retryWindowMs: z.number().int().min(0).default(86_400_000),
  idleTimeoutMs: z.number().int().min(1000).default(60_000),
  // How often the import watcher polls each destination *arr's history to detect
  // which finished downloads it has imported (flipping them import_queued → imported).
  importPollIntervalMs: z.number().int().min(1000).default(30_000),
  // When a jack_manual import trigger keeps failing (e.g. *arr returns 500 because
  // the movie's library folder is missing), the watcher backs off exponentially
  // between attempts instead of re-triggering every tick, and gives up — marking
  // the row failed — after this many attempts. This stops a broken import from
  // flooding *arr indefinitely.
  maxManualImportAttempts: z.number().int().min(1).default(6),
  manualImportBackoffBaseMs: z.number().int().min(0).default(60_000),
  manualImportBackoffMaxMs: z.number().int().min(0).default(1_800_000),
  // Once *arr has imported a download, jack's copy in completedPath is dead weight:
  // *arr either hardlinked it into the library (so the data lives on through the
  // library's link) or copied it. Enabling this unlinks jack's directory entry —
  // never a recursive delete — right after a row flips to `imported`.
  unlinkImportedFiles: z.boolean().default(false),
  // New downloads wait (running ones finish) until this time; see PausedUntil.
  pausedUntil: PausedUntil.nullish(),
})

export type DownloadsConfig = z.infer<typeof DownloadsConfig>

// Raw downloads for persistence: a PATCH body merged onto the stored block, so every
// field is optional and the merged result is validated through DownloadsConfig before
// it reaches the file (see ConfigService.updateDownloads).
//
// `null` on a tuning knob means "drop this key from the file" — the value goes back to
// the schema default above, which is how the UI offers "clear a field to use the
// default". `completedPath` is the one key with no default, so it is not nullable:
// a downloads block without it cannot be validated.
export const RawDownloadsConfig = z.object({
  completedPath: z.string().min(1).optional(),
  maxConcurrentDownloads: z.number().int().min(1).nullish(),
  maxDownloadAttempts: z.number().int().min(1).nullish(),
  retryBaseDelayMs: z.number().int().min(0).nullish(),
  retryMaxDelayMs: z.number().int().min(0).nullish(),
  retryWindowMs: z.number().int().min(0).nullish(),
  idleTimeoutMs: z.number().int().min(1000).nullish(),
  importPollIntervalMs: z.number().int().min(1000).nullish(),
  maxManualImportAttempts: z.number().int().min(1).nullish(),
  manualImportBackoffBaseMs: z.number().int().min(0).nullish(),
  manualImportBackoffMaxMs: z.number().int().min(0).nullish(),
  unlinkImportedFiles: z.boolean().nullish(),
  pausedUntil: PausedUntil.nullish(),
})

export type RawDownloadsConfig = z.infer<typeof RawDownloadsConfig>

const TimeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour HH:MM time')
const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
// KiB/s; absent or null means unlimited.
const RateLimitKiBps = z.number().int().min(1).nullish()

// One entry of the weekly bandwidth schedule. Local time (the container's TZ);
// `start` is inclusive, `end` exclusive, and an `end` at or before `start` runs
// past midnight into the next day. A limit left unset falls back to the
// block-level default.
export const BandwidthPeriod = z.object({
  days: z.array(Weekday).min(1),
  start: TimeOfDay,
  end: TimeOfDay,
  downloadLimitKiBps: RateLimitKiBps,
  uploadLimitKiBps: RateLimitKiBps,
})

export type BandwidthPeriod = z.infer<typeof BandwidthPeriod>

// Combined limits across all peers. Every key applies without a restart.
export const BandwidthConfig = z.object({
  downloadLimitKiBps: RateLimitKiBps,
  uploadLimitKiBps: RateLimitKiBps,
  // Peers asking for a file while this many uploads run get a 503 with
  // Retry-After and retry later. Absent means unlimited.
  maxConcurrentUploads: z.number().int().min(1).nullish(),
  // The same, per friend (per api key), so one friend can't take every slot.
  maxConcurrentUploadsPerPeer: z.number().int().min(1).nullish(),
  // GiB one friend may download from us per day (server time). Past it, new
  // transfers get a 429 with Retry-After until midnight. Absent means no cap.
  dailyUploadLimitGiBPerPeer: z.number().positive().nullish(),
  schedule: z.array(BandwidthPeriod).default([]),
  // Friends asking for a file get a 503 "Sharing is paused" until this time; see PausedUntil.
  pausedUntil: PausedUntil.nullish(),
})

export type BandwidthConfig = z.infer<typeof BandwidthConfig>

// PATCH body for the bandwidth block, merged onto the stored block. `null` drops
// the key; `schedule` is replaced as a whole.
export const RawBandwidthConfig = z.object({
  downloadLimitKiBps: RateLimitKiBps,
  uploadLimitKiBps: RateLimitKiBps,
  maxConcurrentUploads: z.number().int().min(1).nullish(),
  maxConcurrentUploadsPerPeer: z.number().int().min(1).nullish(),
  dailyUploadLimitGiBPerPeer: z.number().positive().nullish(),
  schedule: z.array(BandwidthPeriod).nullish(),
  pausedUntil: PausedUntil.nullish(),
})

export type RawBandwidthConfig = z.infer<typeof RawBandwidthConfig>

// What the Torznab RSS feed offers this instance's *arr apps. A feed of every
// peer's whole catalog lets *arr grab every possible upgrade in one RSS sync, so
// the feed lists only releases a peer added recently, newest first.
export const TorznabConfig = z.object({
  rssMaxAgeDays: z.number().int().min(1).default(7),
  rssMaxItems: z.number().int().min(1).default(100),
})

export type TorznabConfig = z.infer<typeof TorznabConfig>

// PATCH body for the torznab block; `null` drops a key back to its default.
export const RawTorznabConfig = z.object({
  rssMaxAgeDays: z.number().int().min(1).nullish(),
  rssMaxItems: z.number().int().min(1).nullish(),
})

export type RawTorznabConfig = z.infer<typeof RawTorznabConfig>

// Where jack sends notifications. `discord` posts to a Discord webhook URL,
// `ntfy` to an ntfy topic URL, `json` posts `{ event, title, message, at }`
// (e.g. to a Home Assistant webhook). The URL usually embeds a secret.
export const NotificationWebhook = z.object({
  type: z.enum(['discord', 'ntfy', 'json']),
  url: ConfigSecret(),
})

export const NotificationsConfig = z.object({
  webhooks: z.array(NotificationWebhook).default([]),
  // A download that failed for good (after its retries and retry window).
  downloadFailed: z.boolean().default(true),
  // A peer unreachable for this long, and again when it is back.
  peerOffline: z.boolean().default(true),
  peerOfflineMinutes: z.number().int().min(5).default(60),
  // An address banned for repeated failed authentication (see `security`).
  ipBanned: z.boolean().default(true),
  // HH:MM (server time) for a daily summary of traffic and downloads; absent means none.
  dailySummaryAt: TimeOfDay.nullish(),
})

export type NotificationsConfig = z.infer<typeof NotificationsConfig>

// PATCH body: `null` drops a key back to its default; `webhooks` is replaced whole.
export const RawNotificationsConfig = z.object({
  webhooks: z.array(z.object({ type: z.enum(['discord', 'ntfy', 'json']), url: RawConfigSecret })).nullish(),
  downloadFailed: z.boolean().nullish(),
  peerOffline: z.boolean().nullish(),
  peerOfflineMinutes: z.number().int().min(5).nullish(),
  ipBanned: z.boolean().nullish(),
  dailySummaryAt: TimeOfDay.nullish(),
})

export type RawNotificationsConfig = z.infer<typeof RawNotificationsConfig>

// Meeting friends of friends. Nothing that locates this jack (URL, address,
// headers) is shared until both sides have accepted.
export const DiscoveryConfig = z.object({
  // The name friends' friends see. Defaults to jack.external.instanceName.
  publicName: z.string().trim().min(1).max(60).nullish(),
  // Let friends' friends see that name and ask to connect.
  discoverable: z.boolean().default(false),
  // List the friends who opted in to your other friends, and carry their
  // (end-to-end encrypted) requests and messages. Off until you turn it on.
  introduce: z.boolean().default(false),
})

export type DiscoveryConfig = z.infer<typeof DiscoveryConfig>

export const RawDiscoveryConfig = z.object({
  publicName: z.string().trim().min(1).max(60).nullish(),
  discoverable: z.boolean().nullish(),
  introduce: z.boolean().nullish(),
})

export type RawDiscoveryConfig = z.infer<typeof RawDiscoveryConfig>

// What a refused entry looks like in a message: quoted, and short.
function quoteEntry(entry: string): string {
  const text = entry.trim()
  return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`
}

const NOT_AN_ADDRESS = 'isn\'t an IP address or range'

// An address list entry in a PATCH body: refused unless it is an address or range.
const Cidr = z.string().trim().superRefine((entry, ctx) => {
  if (!isAddressOrRange(entry))
    ctx.addIssue({ code: 'custom', message: `${quoteEntry(entry)} ${NOT_AN_ADDRESS}. Use an address like 192.168.1.10 or a range like 172.18.0.0/16.`, input: entry })
})

const warnedEntries = new Set<string>()

/**
 * An address list as stored in config.jsonc. Entries that aren't an address or
 * range (a file written by hand, or by a jack that accepted any text) are left
 * out with a warning instead of stopping jack from starting. A list with no
 * valid entry left counts as unset, so its default applies.
 */
function StoredAddressList(setting: string) {
  return z.array(z.unknown()).nullish().transform((list) => {
    if (!list)
      return list
    const kept: string[] = []
    for (const entry of list) {
      if (typeof entry === 'string' && isAddressOrRange(entry)) {
        kept.push(entry.trim())
        continue
      }
      const shown = typeof entry === 'string' ? quoteEntry(entry) : JSON.stringify(entry)
      if (!warnedEntries.has(`${setting}\0${shown}`)) {
        warnedEntries.add(`${setting}\0${shown}`)
        logger.warn({ setting: `security.${setting}`, entry: shown }, `Ignoring ${shown} in security.${setting}: it ${NOT_AN_ADDRESS}. Fix it under Settings -> Sharing -> Security.`)
      }
    }
    return kept.length === 0 && list.length > 0 ? null : kept
  })
}

// The public port's defences, all on by default: temporary bans for addresses
// that keep failing authentication (like fail2ban), the Radarr/Sonarr APIs only
// for the LAN, and no public API description.
export const SecurityConfig = z.object({
  banEnabled: z.boolean().default(true),
  // Failed attempts (401/403 answers, failed qBittorrent logins) within the window that trigger a ban.
  maxFailures: z.number().int().min(1).max(1000).default(10),
  windowMinutes: z.number().int().min(1).max(1440).default(10),
  banMinutes: z.number().int().min(1).max(525_600).default(60),
  // Proxies whose X-Real-IP / X-Forwarded-For are believed (the reverse proxy in
  // front of jack). When set, it replaces the default: every private address.
  trustedProxies: StoredAddressList('trustedProxies'),
  // Addresses that are never banned on top of the LAN and loopback, which never
  // are (so your *arr apps can't lock themselves out).
  neverBan: StoredAddressList('neverBan'),
  // Answer /torznab and /api/v2 (used only by your own Radarr/Sonarr) only from
  // the LAN, loopback and arrApiAlsoAllowed, also through the reverse proxy.
  lanOnlyArrApis: z.boolean().default(true),
  // Addresses allowed on top of the LAN, e.g. a Radarr on Tailscale or a VPS.
  arrApiAlsoAllowed: StoredAddressList('arrApiAlsoAllowed'),
  // Serve the public port's API description at /openapi.json.
  publicOpenApi: z.boolean().default(false),
})

export type SecurityConfig = z.infer<typeof SecurityConfig>

export const RawSecurityConfig = z.object({
  banEnabled: z.boolean().nullish(),
  maxFailures: z.number().int().min(1).max(1000).nullish(),
  windowMinutes: z.number().int().min(1).max(1440).nullish(),
  banMinutes: z.number().int().min(1).max(525_600).nullish(),
  trustedProxies: z.array(Cidr).nullish(),
  neverBan: z.array(Cidr).nullish(),
  lanOnlyArrApis: z.boolean().nullish(),
  arrApiAlsoAllowed: z.array(Cidr).nullish(),
  publicOpenApi: z.boolean().nullish(),
})

export type RawSecurityConfig = z.infer<typeof RawSecurityConfig>

export const AppConfig = z.object({
  version: z.number(),
  jack: JackConfig,
  downloads: DownloadsConfig.optional(),
  bandwidth: BandwidthConfig.optional(),
  torznab: TorznabConfig.optional(),
  notifications: NotificationsConfig.optional(),
  discovery: DiscoveryConfig.optional(),
  security: SecurityConfig.optional(),
  servers: z.array(ServerConfig).default([]),
  peers: z.array(PeerConfig).default([]),
})

export type AppConfig = z.infer<typeof AppConfig>

export const MIGRATIONS = [
  <T extends object>(obj: T): T & { version: number } => ({ ...obj, version: 1 }),
  // v2: rename jack.baseUrl → jack.internalUrl (an external URL will be added later).
  <T extends object>(obj: T): T & { version: number } => {
    const cfg = obj as T & { jack?: Record<string, unknown> }
    if (cfg.jack && 'baseUrl' in cfg.jack) {
      const { baseUrl, ...rest } = cfg.jack
      return { ...obj, jack: { ...rest, internalUrl: baseUrl }, version: 2 } as T & { version: number }
    }
    return { ...obj, version: 2 } as T & { version: number }
  },
]
const LATEST_MIGRATION = MIGRATIONS.length

export function migrateConfig(rawConfigObject: unknown) {
  const configObject = z
    .looseObject({ version: z.number().max(LATEST_MIGRATION).min(0).default(0).catch(0) })
    .parse(rawConfigObject)

  const currentVersion = configObject.version
  const migrationsToApply = MIGRATIONS.slice(currentVersion)

  if (migrationsToApply.length === 0) {
    return
  }

  logger.debug(`Migrating config from version ${currentVersion} to version ${MIGRATIONS.length}`)

  return migrationsToApply.reduce((acc, migration, idx) => {
    logger.trace({ input: acc }, `Migrating to version ${idx + 1}`)
    return migration(acc)
  }, configObject)
}

export const DEFAULT_INTERNAL_URL = 'http://jack:5225'
// Where the Unraid template mounts the downloads folder.
export const DEFAULT_DOWNLOADS_PATH = '/data/jack'

const EMPTY_APP_CONFIG: AppConfig = {
  version: MIGRATIONS.length,
  // jack is required; the resolved fallback carries only an internalUrl (no master key —
  // auto-registration provisions its own managed keys).
  jack: { internalUrl: DEFAULT_INTERNAL_URL },
  servers: [],
  peers: [],
}

const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
const TRAILING_SLASHES = /\/+$/
const HTTP_PROTOCOL = /^https?$/

/**
 * The JACK_INTERNAL_URL value as a config URL: `http://` is added when no scheme is
 * given, trailing slashes are dropped. Undefined (with a warning) when it still
 * isn't an http(s) URL, so jack falls back to the default instead of failing to start.
 */
export function internalUrlFromEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed)
    return undefined
  const candidate = (URL_SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`).replace(TRAILING_SLASHES, '')
  const parsed = z.url({ protocol: HTTP_PROTOCOL }).safeParse(candidate)
  if (parsed.success)
    return parsed.data
  logger.warn({ JACK_INTERNAL_URL: value }, `JACK_INTERNAL_URL is not an http(s) URL; using ${DEFAULT_INTERNAL_URL}`)
  return undefined
}

export interface DefaultAppConfigOptions {
  /** Seeds jack.internalUrl (JACK_INTERNAL_URL). */
  internalUrl?: string
  /** Turned into downloads.completedPath when it is a writable folder. */
  downloadsPath?: string
}

/**
 * The config a first start writes. Downloads start on when the downloads folder
 * (`/data/jack` in the Unraid template) exists and jack can write to it.
 */
export async function buildDefaultAppConfig({ internalUrl, downloadsPath = DEFAULT_DOWNLOADS_PATH }: DefaultAppConfigOptions = {}): Promise<z.input<typeof AppConfig>> {
  const downloads = await isWritableDirectory(downloadsPath) ? { completedPath: downloadsPath } : undefined
  return {
    version: MIGRATIONS.length,
    jack: { internalUrl: internalUrlFromEnv(internalUrl) ?? DEFAULT_INTERNAL_URL },
    ...(downloads ? { downloads } : {}),
    servers: [],
    peers: [],
  }
}

/** Write the default config to `path` unless a file is already there. Returns what was written, or null. */
export async function createDefaultAppConfig(path: string, options: DefaultAppConfigOptions = {}): Promise<z.input<typeof AppConfig> | null> {
  if (await fs.exists(path))
    return null
  const config = await buildDefaultAppConfig(options)
  await fs.writeFile(path, jsonc.stringify(config, { space: 2 }))
  logger.info({ internalUrl: config.jack.internalUrl, completedPath: config.downloads?.completedPath ?? null }, 'Wrote the default config')
  return config
}

export async function getAppConfig(
  { APP_CONFIG_PATH, JACK_INTERNAL_URL }: Pick<Envs, 'APP_CONFIG_PATH'> & Partial<Pick<Envs, 'JACK_INTERNAL_URL'>>,
  { downloadsPath }: Pick<DefaultAppConfigOptions, 'downloadsPath'> = {},
): Promise<{ appConfig: AppConfig, raw: z.input<typeof AppConfig> }> {
  const configFileExists = await fs.exists(APP_CONFIG_PATH)

  if (!configFileExists) {
    logger.warn(`Config file not found at ${APP_CONFIG_PATH}. Creating default config file...`)
    const defaults = await createDefaultAppConfig(APP_CONFIG_PATH, { internalUrl: JACK_INTERNAL_URL, downloadsPath })
      ?? await buildDefaultAppConfig({ internalUrl: JACK_INTERNAL_URL, downloadsPath })

    const defaultConfig = AppConfig.safeParse(defaults)
    if (defaultConfig.success)
      return { appConfig: defaultConfig.data, raw: defaults }

    // The runtime config is empty (the referenced secrets can't be resolved yet),
    // but `raw` must mirror what we just wrote to disk — the default config, jack
    // template included. Seeding ConfigService with EMPTY_APP_CONFIG instead would
    // make the first management mutation persist a config without the jack template,
    // silently clobbering the file that createDefaultAppConfig just created.
    logger.warn('Default config references environment variables that are not set. Starting with an empty config until they are provided.')
    return { appConfig: EMPTY_APP_CONFIG, raw: defaults }
  }

  logger.debug(`Loading config file from ${APP_CONFIG_PATH}`)
  const fileTextContent = await Bun.file(APP_CONFIG_PATH).text()
  const fileContent = jsonc.parse(fileTextContent)

  // `migrateConfig` returns the migrated object, or `undefined` when the file is
  // already current. On a real migration, back up the original bytes (comments
  // intact) then atomically rewrite the file so the upgrade is durable.
  const migrated = migrateConfig(fileContent)
  if (migrated) {
    logger.info(`Config migrated; writing backup to ${APP_CONFIG_PATH}.bak and persisting`)
    await Bun.write(`${APP_CONFIG_PATH}.bak`, fileTextContent)
    await atomicWriteFile(APP_CONFIG_PATH, jsonc.stringify(migrated, { space: 2 }))
  }

  // `migrated ?? fileContent` also fixes the up-to-date-file crash (migrateConfig
  // returns undefined when current; parsing undefined used to throw).
  const raw = (migrated ?? fileContent) as z.input<typeof AppConfig>
  logger.debug(`Validating app config`)
  return { appConfig: AppConfig.parse(raw), raw }
}
