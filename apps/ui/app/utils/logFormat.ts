import type { LogRecord } from '~/types/management'
import { docsUrl } from './docs'
import { settingsLink } from './settings-links'

// Keys that carry structural meaning and are rendered in dedicated columns, so
// they're excluded from the "extra fields" detail dump.
const RESERVED = new Set([
  '_id',
  '_count',
  '_durations',
  'time',
  'level',
  'severity',
  'message',
  'msg',
  'pid',
  'hostname',
])

export type LevelKey = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVEL_KEYS = new Set<string>(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

// Prefer the string `severity`, but only when it's a label we can style — an
// unrecognised one (a custom level like `critical`) would miss LEVEL_STYLES and
// mis-render as INFO, hiding a high-priority line. Fall through to the numeric
// pino level in that case rather than trusting the string blindly.
export function levelName(record: LogRecord): LevelKey {
  const severity = typeof record.severity === 'string' ? record.severity.toLowerCase() : undefined
  if (severity && LEVEL_KEYS.has(severity))
    return severity as LevelKey
  const l = typeof record.level === 'number' ? record.level : 30
  return l >= 60 ? 'fatal' : l >= 50 ? 'error' : l >= 40 ? 'warn' : l >= 30 ? 'info' : l >= 20 ? 'debug' : 'trace'
}

export interface LevelStyle {
  label: string
  // Colour of the level word itself.
  text: string
  // Left rail: lit only for warn+ so anomalies surface out of the trace flood.
  rail: string
}

const LEVEL_STYLES: Record<LevelKey, LevelStyle> = {
  trace: { label: 'TRACE', text: 'text-dimmed', rail: 'border-l-transparent' },
  debug: { label: 'DEBUG', text: 'text-dimmed', rail: 'border-l-transparent' },
  info: { label: 'INFO', text: 'text-muted', rail: 'border-l-transparent' },
  warn: { label: 'WARN', text: 'text-warning', rail: 'border-l-warning' },
  error: { label: 'ERROR', text: 'text-error', rail: 'border-l-error' },
  fatal: { label: 'FATAL', text: 'text-error', rail: 'border-l-error' },
}

export function levelStyle(record: LogRecord): LevelStyle {
  // A severity string we can't map (a custom level like `critical`) with no
  // numeric level would otherwise fall to INFO and hide. Show its own label with
  // a lit rail so it can't pass as a normal line — we can't rank it, so treat it
  // as noteworthy rather than silently benign.
  const severity = typeof record.severity === 'string' ? record.severity.trim() : ''
  if (severity && !LEVEL_KEYS.has(severity.toLowerCase()) && typeof record.level !== 'number')
    return { label: severity.toUpperCase(), text: 'text-warning', rail: 'border-l-warning' }
  return LEVEL_STYLES[levelName(record)] ?? LEVEL_STYLES.info
}

export interface HttpInfo {
  method: string
  path: string
  status?: number
}

// A request log carries an `http.request.method` — everything else falls through
// to the plain message renderer.
export function extractHttp(record: LogRecord): HttpInfo | null {
  const http = record.http as { request?: { method?: unknown, path?: unknown }, response?: { status?: unknown } } | undefined
  if (!http || typeof http !== 'object')
    return null
  const method = http.request?.method
  if (typeof method !== 'string')
    return null
  return {
    method,
    path: typeof http.request?.path === 'string' ? http.request.path : '',
    status: typeof http.response?.status === 'number' ? http.response.status : undefined,
  }
}

// HTTP verbs coloured like a network inspector: read=blue, create=green,
// mutate=amber, destroy=red. Kept subtle so status/latency anomalies dominate.
export function methodClass(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET': return 'text-info'
    case 'POST': return 'text-success'
    case 'PUT':
    case 'PATCH': return 'text-warning'
    case 'DELETE': return 'text-error'
    default: return 'text-muted'
  }
}

export function statusClass(status: number | undefined): string {
  if (status == null)
    return 'text-dimmed'
  if (status >= 500)
    return 'text-error'
  if (status >= 400)
    return 'text-warning'
  if (status >= 300)
    return 'text-info'
  if (status >= 200)
    return 'text-success'
  return 'text-muted'
}

export function latencyClass(ms: number): string {
  if (ms >= 500)
    return 'text-error'
  if (ms >= 100)
    return 'text-warning'
  if (ms >= 20)
    return 'text-toned'
  return 'text-dimmed'
}

// Compact, human duration. Sub-10ms keeps one decimal (the common request case),
// everything else rounds; past a second it flips to seconds.
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms))
    return ''
  if (ms >= 1000)
    return `${(ms / 1000).toFixed(2)}s`
  if (ms >= 10)
    return `${Math.round(ms)}ms`
  return `${ms.toFixed(1)}ms`
}

// Micro-bar fill, 0-100. Log-scaled against a fixed 500ms reference so bars stay
// comparable across the whole stream (a spike always reads as a spike) and a
// 1ms request still shows a visible nub instead of nothing.
const LAT_REF = Math.log10(501)
export function latencyFill(ms: number): number {
  if (!(ms > 0))
    return 0
  const pct = (Math.log10(ms + 1) / LAT_REF) * 100
  return Math.max(4, Math.min(100, pct))
}

// Colour for the micro-bar track (matches the latency thresholds, but as a fill).
export function latencyBarClass(ms: number): string {
  if (ms >= 500)
    return 'bg-error'
  if (ms >= 100)
    return 'bg-warning'
  if (ms >= 20)
    return 'bg-info'
  return 'bg-muted'
}

function recordDate(time: unknown): Date | null {
  if (typeof time !== 'number')
    return null
  const d = new Date(time)
  return Number.isNaN(d.getTime()) ? null : d
}

// HH:MM:SS.mmm — millisecond precision matters when dozens of lines share a second.
export function clockTime(time: unknown): string {
  const d = recordDate(time)
  if (!d)
    return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

// Days in the browser's time zone, put together by hand: runtimes disagree on the
// comma in en-GB's "Sat, 17 Oct".
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' })
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

function dayName(d: Date, withYear: boolean): string {
  const day = `${WEEKDAY.format(d)} ${DAY_MONTH.format(d)}`
  return withYear ? `${day} ${d.getFullYear()}` : day
}

/** The record's local calendar day ("2026-10-17"), empty without a valid time. */
export function logDayKey(time: unknown): string {
  const d = recordDate(time)
  if (!d)
    return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "Today", "Yesterday", "Sat 17 Oct", or "Sat 17 Oct 2025" in another year. */
export function logDayLabel(time: unknown, now: number = Date.now()): string {
  const d = recordDate(time)
  if (!d)
    return ''
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const key = logDayKey(time)
  if (key === logDayKey(today.getTime()))
    return 'Today'
  if (key === logDayKey(yesterday.getTime()))
    return 'Yesterday'
  return dayName(d, d.getFullYear() !== today.getFullYear())
}

/** "Sat 17 Oct 2026, 21:05:39.123", for the detail panel and the row's tooltip. */
export function logDateTime(time: unknown): string {
  const d = recordDate(time)
  return d ? `${dayName(d, true)}, ${clockTime(time)}` : ''
}

/** The record's time as ISO 8601, for `<time datetime>`. */
export function logIsoTime(time: unknown): string | undefined {
  return recordDate(time)?.toISOString()
}

/**
 * The day to show above each row, aligned with `rows`: a label where a row starts
 * a new day, otherwise an empty string. A list that holds only today's lines gets
 * no labels; one that reaches back further gets one above each day, today's too.
 */
export function logDayBreaks(rows: ReadonlyArray<{ time?: unknown }>, now: number = Date.now()): string[] {
  const today = logDayKey(now)
  let previous = today
  return rows.map((row) => {
    const key = logDayKey(row.time)
    if (!key || key === previous)
      return ''
    previous = key
    return logDayLabel(row.time, now)
  })
}

// Matched on jack's wording in index.ts and lib/servers/index.ts, like LOG_HELP
// below. A changed message there needs a change here.
// Logged once per start, when jack is up.
const STARTED = 'Server listening'
// Lines that belong to a run before the start being traced back: the end of
// the one before it (a shutdown), or that run being up.
const RUN_EDGE = /^(?:Server listening|Management API listening|\w+ received, exiting)$/
// A start logs its first lines in a burst, and the previous run's last line comes
// at least the restart time before them (0.7 s and more on a docker restart).
const STARTUP_BURST_MS = 500
// The burst ends with these, one per Radarr/Sonarr. jack then waits for each to
// answer, up to a timeout, and logs the outcome, so lines can be far apart.
const CHECK_STARTED = /^Initializing connector /
const CHECK_LINE = /^(?:Initializing|Initialized|Failed to initialize) connector /
// No start takes longer than this from its first line to STARTED.
const STARTUP_MAX_MS = 120_000

type RunRecord = Readonly<{ time?: unknown, message?: unknown, hostname?: unknown }>

function messageOf(row: RunRecord): string {
  return typeof row.message === 'string' ? row.message : ''
}

// The index of the first line of the start whose STARTED line is at `startedAt`,
// walking back through the lines jack logged while starting.
function runStart(rows: ReadonlyArray<RunRecord>, startedAt: number): number {
  const started = rows[startedAt]!
  if (typeof started.time !== 'number')
    return startedAt
  let first = startedAt
  // Walking back through the wait for the Radarr/Sonarr checks, until the line
  // that started the last of them.
  let checking = true
  for (let i = startedAt - 1; i >= 0; i--) {
    const row = rows[i]!
    const next = rows[first]!
    if (RUN_EDGE.test(messageOf(row)))
      break
    // pino's hostname is the container's: a new one means a recreated jack.
    if (row.hostname !== next.hostname)
      break
    if (typeof row.time !== 'number' || typeof next.time !== 'number' || started.time - row.time > STARTUP_MAX_MS)
      break
    if (next.time - row.time > STARTUP_BURST_MS && !(checking && CHECK_LINE.test(messageOf(row))))
      break
    if (CHECK_STARTED.test(messageOf(row)))
      checking = false
    first = i
  }
  return first
}

/**
 * Which jack run each row (oldest to newest) belongs to: 0 up to the first start
 * the list holds, then one more from the first line of each start. A start is
 * the "Server listening" line plus the lines jack logged just before it while
 * starting (config, connectors). pid can't tell runs apart: it is 1 in every
 * container start.
 */
export function logRuns(rows: ReadonlyArray<RunRecord>): number[] {
  const firsts = new Set<number>()
  rows.forEach((row, index) => {
    if (row.message === STARTED)
      firsts.add(runStart(rows, index))
  })
  let run = 0
  return rows.map((_, index) => firsts.has(index) ? ++run : run)
}

/**
 * Which rows get a divider above them, given each row's number in a sequence
 * that only grows (a run from logRuns, say): those whose number differs from the
 * row before, and the first row when its number is past 0.
 */
export function logSegmentBreaks(numbers: ReadonlyArray<number>): boolean[] {
  return numbers.map((n, index) => n !== (index === 0 ? 0 : numbers[index - 1]))
}

// Signature that folds consecutive repeats: same level + message + request shape,
// ignoring per-occurrence noise (time, trace ids, duration). Non-request repeats
// fold on their full extra-field payload so distinct warnings never merge.
export function groupKey(record: LogRecord): string {
  const level = levelName(record)
  const http = extractHttp(record)
  if (http)
    return `h|${level}|${record.message ?? ''}|${http.method} ${http.path} ${http.status ?? ''}`
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (RESERVED.has(k) || k === 'trace_id' || k === 'span_id' || k === 'trace_flags')
      continue
    extra[k] = v
  }
  return `m|${level}|${record.message ?? ''}|${JSON.stringify(extra)}`
}

// Flattened key -> stringified value for the detail panel. Nested objects (the
// `http` block) become dotted paths; everything is presented, nothing hidden.
export function extraFields(record: LogRecord): Array<{ key: string, value: string }> {
  const out: Array<{ key: string, value: string }> = []
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!prefix && RESERVED.has(k))
        continue
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v))
        walk(v as Record<string, unknown>, key)
      else
        out.push({ key, value: typeof v === 'string' ? v : JSON.stringify(v) })
    }
  }
  walk(record, '')
  return out
}

// Full record as pretty JSON for the raw view / copy, minus our internal tags.
export function rawJson(record: LogRecord): string {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (k === '_id' || k === '_count' || k === '_durations')
      continue
    clean[k] = v
  }
  return JSON.stringify(clean, null, 2)
}

export interface LogHelp {
  label: string
  to: string
  // The guide on GitHub opens in a new tab; settings stay in the app.
  external: boolean
}

const TROUBLESHOOTING: LogHelp = { label: 'Troubleshooting guide', to: docsUrl('unraid', 'troubleshooting'), external: true }

// Log lines with a known fix, matched on jack's wording in index.ts,
// lib/autoregister.ts, modules/registration/registration.service.ts and
// modules/security/lan-guard.ts. A changed message there needs a change here.
const LOG_HELP: Array<{ pattern: RegExp, help: LogHelp }> = [
  { pattern: /^Downloads are off\b/, help: TROUBLESHOOTING },
  { pattern: /^Turned off the Jack indexer\b/, help: TROUBLESHOOTING },
  { pattern: /^Failed to register\b|^Registration failed\b/, help: TROUBLESHOOTING },
  { pattern: / can't use jack: /, help: TROUBLESHOOTING },
  { pattern: /^Refused the Radarr\/Sonarr API\b/, help: { label: 'Open Security settings', to: settingsLink('security'), external: false } },
]

export function logHelp(record: LogRecord): LogHelp | null {
  const message = typeof record.message === 'string' ? record.message : ''
  return LOG_HELP.find(entry => entry.pattern.test(message))?.help ?? null
}
