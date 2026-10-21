import type { VersionInfo } from '../../lib/build'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { ApiKeyMeta } from '../api-keys/api-key-meta'
import type { ApiKeysRepository } from '../api-keys/api-keys.repository'
import type { PeerHealthMonitor } from '../friends/peer-health'
import type { LogRecord } from '../logging/log-hub'
import type { RegistrationStatus } from '../registration/registration.service'
import type { RestartReason } from '../status/restart-pending'
import type { PauseState, PauseTarget } from '../transfers/pause'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { isSensitiveField } from '../../lib/redact'

export const SUPPORT_REDACTED = '[redacted]'
export const SUPPORT_WEBHOOK_REMOVED = '[webhook URL removed]'

// Log lines in the bundle: the newest that keepInSupportLog accepts.
export const SUPPORT_LOG_LINES = 50
const LOG_WARN_LEVEL = 40
// A value shorter than this is too common to scrub wherever it appears.
const MIN_SECRET_LENGTH = 6
const MAX_STRING_LENGTH = 2000
const MAX_DEPTH = 8

const LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }
// Log fields that say nothing about the problem.
const DROPPED_LOG_FIELDS = new Set(['time', 'level', 'severity', 'hostname', 'pid', 'environment', 'trace_id', 'span_id', 'trace_flags'])
// Object keys whose values are dropped whatever they hold.
const SECRET_KEYS = /^(?:headers?|cookies?|webhooks?|x-[\w-]*key|.*secret.*)$/i

// URL credentials: scheme://user:password@host
const URL_USERINFO = /\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#@"'<>]+@/gi
// Webhook URLs carry their token in the path (Discord, Slack, Home Assistant, ...).
const WEBHOOK_URL = /\bhttps?:\/\/[^\s"'<>]*\/(?:api\/)?webhooks?\/[^\s"'<>]*/gi
// Query parameters that hold credentials.
const SECRET_QUERY = /([?&](?:api[_-]?key|key|token|access[_-]?token|auth|password|passwd|secret|sig|signature)=)[^&\s#"'<>]+/gi
// "X-Api-Key: value", "authorization=Bearer value" and the like in free text.
const SECRET_HEADER_TEXT = /\b(x-api-key|x-management-key|authorization|proxy-authorization|cookie|set-cookie|cf-access-client-secret|cf-access-client-id)(["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;}]+/gi
// jack keys (jack_<hex>, jack_managed_<hex>) and long hex strings such as *arr API keys.
const KEY_LIKE = /\bjack_(?:managed_)?[\da-f]{16,}\b|\b[\da-f]{32,}\b/gi

/**
 * Whether a log record goes in the bundle: warnings, errors, and the info lines
 * marked `recovered: true`, which say that something that failed works again
 * (a connector that failed to initialize, see ServerConnector.init). Without
 * them the bundle ends on an error that has since cleared.
 */
export function keepInSupportLog(record: LogRecord): boolean {
  return typeof record.level === 'number' && (record.level >= LOG_WARN_LEVEL || record.recovered === true)
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g
const escapeRegExp = (value: string) => value.replace(REGEXP_SPECIAL, '\\$&')

/**
 * Remove what must not leave this server from a piece of text: the given
 * secret values (keys, header values, webhook URLs from the config), URL
 * credentials, webhook URLs, credential query parameters, header values
 * written out as text, and anything shaped like a key.
 */
export function redactSupportText(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= MIN_SECRET_LENGTH)
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), SUPPORT_REDACTED)
  }
  out = out
    .replace(WEBHOOK_URL, SUPPORT_WEBHOOK_REMOVED)
    .replace(URL_USERINFO, '$1')
    .replace(SECRET_QUERY, `$1${SUPPORT_REDACTED}`)
    .replace(SECRET_HEADER_TEXT, `$1$2${SUPPORT_REDACTED}`)
    .replace(KEY_LIKE, SUPPORT_REDACTED)
  return out.length > MAX_STRING_LENGTH ? `${out.slice(0, MAX_STRING_LENGTH)}...` : out
}

/**
 * The bundle's value with every string passed through redactSupportText, and
 * values under credential-like keys (apiKey, token, headers, webhooks, ...)
 * replaced as a whole.
 */
export function redactForSupport<T>(value: T, secrets: readonly string[] = [], depth = 0): T {
  if (typeof value === 'string')
    return redactSupportText(value, secrets) as T
  if (value === null || typeof value !== 'object')
    return value
  if (depth >= MAX_DEPTH)
    return SUPPORT_REDACTED as T
  if (Array.isArray(value))
    return value.map(item => redactForSupport(item, secrets, depth + 1)) as T
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [
    key,
    val != null && (isSensitiveField(key) || SECRET_KEYS.test(key)) ? SUPPORT_REDACTED : redactForSupport(val, secrets, depth + 1),
  ])) as T
}

function resolveSecretRef(value: unknown, env: Record<string, string | undefined>): string | null {
  if (typeof value === 'string')
    return value
  if (value && typeof value === 'object') {
    if ('env' in value && typeof value.env === 'string')
      return env[value.env] ?? null
    if ('file' in value && typeof value.file === 'string' && isAbsolute(value.file)) {
      try {
        return readFileSync(value.file, 'utf8').trim()
      }
      catch {
        return null
      }
    }
  }
  return null
}

/**
 * Every secret value in a raw config (refs resolved): API keys, the TMDB key,
 * header values, webhook URLs. Used to scrub them from free text such as log
 * lines and error messages.
 */
export function configSecrets(raw: unknown, env: Record<string, string | undefined> = process.env): string[] {
  const found = new Set<string>()
  const add = (value: unknown) => {
    const resolved = resolveSecretRef(value, env)
    if (resolved && resolved.length >= MIN_SECRET_LENGTH)
      found.add(resolved)
  }
  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object')
      return
    if (Array.isArray(node)) {
      for (const item of node)
        walk(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'apiKey' || key === 'tmdbApiKey') {
        add(value)
      }
      else if (key === 'headers' && value && typeof value === 'object') {
        for (const header of Object.values(value))
          add(header)
      }
      else if (key === 'webhooks' && Array.isArray(value)) {
        for (const webhook of value)
          add((webhook as { url?: unknown } | null)?.url)
      }
      else {
        walk(value, depth + 1)
      }
    }
  }
  walk(raw, 0)
  return [...found]
}

export interface SupportBundleDeps {
  version: () => VersionInfo
  /** jack.internalUrl as stored now. */
  internalUrl: () => string | null
  /** Whether jack.external is set (the address itself is left out). */
  externalConfigured: () => boolean
  downloads: () => { configured: boolean, active: boolean }
  restartPending: () => RestartReason[]
  paused?: () => Record<PauseTarget, PauseState>
  servers: () => ArrServerConnector[]
  registrations?: Pick<RegistrationStatus, 'registration' | 'lastContactAt'>
  peers: () => PeerConnector[]
  health?: Pick<PeerHealthMonitor, 'get'>
  apiKeys?: Pick<ApiKeysRepository, 'list'>
  keyMeta?: Pick<ApiKeyMeta, 'all'>
  /** The newest `lines` log records that `keep` accepts, oldest first. */
  logs: (lines: number, keep: (record: LogRecord) => boolean) => Promise<LogRecord[]>
  /** Secret values to scrub from the bundle (see configSecrets). */
  secrets: () => string[]
  now?: () => Date
  timeZone?: () => string
}

function hostOf(url: string | null): string | null {
  if (!url)
    return null
  try {
    return new URL(url).host
  }
  catch {
    return null
  }
}

function utcOffset(at: Date): string {
  const minutes = -at.getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

function logLine(record: LogRecord): Record<string, unknown> {
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => !DROPPED_LOG_FIELDS.has(key) && key !== 'message' && key !== 'msg'))
  return {
    time: typeof record.time === 'number' ? new Date(record.time).toISOString() : null,
    level: typeof record.level === 'number' ? LEVEL_NAMES[record.level] ?? String(record.level) : null,
    message: typeof record.message === 'string' ? record.message : typeof record.msg === 'string' ? record.msg : null,
    ...fields,
  }
}

/**
 * What a friend needs to help with a problem, without anything that lets
 * someone else in: builds, time zone, the internal URL's host, downloads,
 * restart, servers, peers, key names and the last warnings and errors (see
 * keepInSupportLog). Every string goes through redactForSupport.
 */
export async function buildSupportBundle(deps: SupportBundleDeps) {
  const now = (deps.now ?? (() => new Date()))()
  const metaByKey = deps.keyMeta?.all()
  const peers = deps.peers()
  const bundle = {
    generatedAt: now.toISOString(),
    note: 'Made by jack for troubleshooting. API keys, header values, webhook URLs and URL credentials are removed. Error messages and log lines can contain the addresses of your Radarr, Sonarr and friends.',
    timeZone: deps.timeZone?.() ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffset: utcOffset(now),
    internalUrlHost: hostOf(deps.internalUrl()),
    externalConfigured: deps.externalConfigured(),
    downloads: deps.downloads(),
    restartPending: deps.restartPending(),
    paused: deps.paused?.() ?? null,
    servers: deps.servers().map((server) => {
      const registration = deps.registrations?.registration(server.id) ?? null
      return {
        name: server.name,
        type: server.type,
        source: server.canSource,
        destination: server.canDestination,
        autoregister: server.autoRegister.enable,
        initialized: server.isInitialized,
        initializationError: server.initializationError,
        registration: registration && {
          at: registration.at,
          indexer: registration.indexer,
          downloadClient: registration.downloadClient,
          reason: registration.reason ?? null,
          clientTest: registration.clientTest,
          indexerTest: registration.indexerTest,
          message: registration.message,
          testErrors: registration.testErrors,
          indexerPaused: registration.indexerPaused,
        },
        lastContactAt: deps.registrations?.lastContactAt(server.id) ?? null,
      }
    }),
    peers: peers.map((peer) => {
      const health = deps.health?.get(peer)
      return {
        name: peer.name,
        connected: peer.isInitialized,
        online: health?.online ?? null,
        offlineSince: health?.offlineSince ?? null,
        lastSeenAt: health?.lastSeenAt ?? null,
        lastErrorCode: health?.lastErrorCode ?? null,
        lastError: health?.lastError ?? null,
        version: health?.version ?? peer.peerVersion,
      }
    }),
    keys: (deps.apiKeys?.list() ?? []).map(key => ({
      name: key.name,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      lastUsedAt: metaByKey?.get(key.id)?.lastUsedAt ?? null,
      origin: metaByKey?.get(key.id)?.origin ?? null,
      linkedToPeer: Boolean(metaByKey?.get(key.id)?.peerId),
    })),
    logs: (await deps.logs(SUPPORT_LOG_LINES, keepInSupportLog).catch(() => [])).map(logLine),
  }
  const redacted = redactForSupport(bundle, deps.secrets())
  // Builds go in after redaction: a git revision looks like a key to it, and
  // both are checked when read (see lib/build.ts).
  const { generatedAt, note, ...rest } = redacted
  return {
    generatedAt,
    note,
    jack: deps.version(),
    ...rest,
    peers: rest.peers.map((peer, i) => ({ ...peer, build: deps.health?.get(peers[i]!).build ?? null })),
  }
}

export type SupportBundle = Awaited<ReturnType<typeof buildSupportBundle>>
