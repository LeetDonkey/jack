import type { DestinationRegistration, RegistrationStep, RegistrationTest, ServerRegistrationFields } from '~/types/management'
import type { SettingsSectionId } from '~/utils/settings-links'
import { formatClockOrDay, formatClockTime } from './format'

/** Display name for a server's `type` ("radarr" -> "Radarr"). */
export function arrName(type: string): string {
  return type === 'sonarr' ? 'Sonarr' : 'Radarr'
}

/** What friends share with a server of this `type`: "movies" or "episodes". */
export function arrMedia(type: string): string {
  return type === 'sonarr' ? 'episodes' : 'movies'
}

/**
 * What a Radarr/Sonarr does for jack, in words: `source` shares its library with
 * friends, `destination` receives downloads from them.
 */
export function serverRoleLabel(server: { source: boolean, destination: boolean }): string {
  const roles: string[] = []
  if (server.source)
    roles.push('shares with friends')
  if (server.destination)
    roles.push('receives downloads')
  return roles.join(' · ') || 'not in use'
}

/** Whether jack adds itself to this server, so it has a registration to show. */
export function registersJack(server: { destination: boolean, autoregister: { enable: boolean } }): boolean {
  return server.destination && server.autoregister.enable
}

export type RegistrationTone = 'ok' | 'warning' | 'error'

export type RegistrationKind = 'indexer' | 'downloadClient'

export interface RegistrationPart {
  text: string
  tone: RegistrationTone
}

/**
 * When the *arr skips jack's indexer after failures (Radarr/Sonarr pause an
 * indexer for longer after each one), while that is still ahead of `now`. They
 * resume it by themselves at that time.
 */
export function indexerPausedUntil(registration: DestinationRegistration | null, now: number): string | null {
  const until = registration?.indexerPausedUntil
  if (!until)
    return null
  const at = Date.parse(until)
  return Number.isNaN(at) || at <= now ? null : until
}

/**
 * Whether the *arr skips jack's indexer for now, and until when if it says.
 * Radarr and Sonarr only say that they do (`indexerPaused`), so `until` is
 * null for them.
 */
export function indexerPause(registration: DestinationRegistration | null, now: number): { until: string | null } | null {
  const until = indexerPausedUntil(registration, now)
  if (until)
    return { until }
  return registration?.indexerPaused === true ? { until: null } : null
}

/** "17:36" for a time today, "03:10 on 20 Oct" for another day. */
export function formatPauseEnd(iso: string, now: number): string {
  const clock = formatClockTime(iso)
  const day = formatClockOrDay(iso, now)
  return day === clock ? clock : `${clock} on ${day}`
}

/**
 * The sentences about a paused indexer, or null while the *arr isn't skipping it:
 * what the pause means, and that it ends by itself. When the pause is all that is
 * wrong with the registration, they add that nothing needs doing. Next to a failed
 * step, a client that waits for a restart or the backend's message, that would
 * contradict the fix those ask for.
 *
 * Register again isn't offered. It ends the pause only when the *arr's test finds
 * something in jack's feed, which lists only friends' releases of the last
 * `torznab.rssMaxAgeDays`, and a test that finds nothing can make the pause longer.
 */
export function indexerPauseText(server: { name: string, type: string }, registration: DestinationRegistration | null, now: number): { title: string, detail: string } | null {
  const pause = indexerPause(registration, now)
  if (!registration || !pause)
    return null
  const { name } = server
  const alone = !registration.message
    && registration.reason !== 'downloads-off'
    && registrationStepTone('indexer', registration.indexer, registration.indexerTest) === 'ok'
    && registrationStepTone('downloadClient', registration.downloadClient, registration.clientTest) === 'ok'
  const media = arrMedia(server.type)
  if (!pause.until) {
    const resumes = `${name} resumes it by itself after a while, and jack resumes it once a friend adds new ${media}.`
    return {
      title: `${name} is skipping jack's indexer for a while after earlier errors, so it won't find friends' ${media} until then.`,
      detail: alone ? `${resumes} You don't need to do anything.` : resumes,
    }
  }
  const resumes = `${name} pauses an indexer after errors and resumes it by itself at that time.`
  return {
    title: `${name} is skipping jack's indexer until ${formatPauseEnd(pause.until, now)}, so it won't find friends' ${media} before then.`,
    detail: alone ? `${resumes} You don't need to do anything.` : resumes,
  }
}

/**
 * Added, but not tested. jack skips the test only for a download client it can't
 * serve yet: downloads were turned on after jack started, and the *arr can use the
 * client once the jack container restarts.
 */
function waitsForRestart(kind: RegistrationKind, step: RegistrationStep, test: RegistrationTest): boolean {
  return kind === 'downloadClient' && step.status === 'ok' && test === 'skipped'
}

/**
 * How one registration step went. A step jack added but the *arr's own test of it
 * failed is as broken as one jack couldn't add: the *arr can't use it either way.
 * An indexer the *arr skips for now (`paused`) works again once the pause ends.
 */
export function registrationStepTone(kind: RegistrationKind, step: RegistrationStep, test: RegistrationTest, paused = false): RegistrationTone {
  if (step.status === 'failed' || test === 'failed')
    return 'error'
  if (step.status === 'skipped' || waitsForRestart(kind, step, test))
    return 'warning'
  return kind === 'indexer' && paused ? 'warning' : 'ok'
}

const PART_WORDS: Record<RegistrationTone, string> = { ok: '✓', warning: 'skipped', error: 'failed' }

function partWords(kind: RegistrationKind, step: RegistrationStep, test: RegistrationTest, tone: RegistrationTone): string {
  if (waitsForRestart(kind, step, test))
    return 'waits for a restart'
  if (tone === 'warning' && step.status === 'ok')
    return 'paused'
  // Added, and nothing tested it yet.
  if (tone === 'ok' && test === 'skipped')
    return 'added'
  return PART_WORDS[tone]
}

/**
 * The "jack in Radarr: …" line on a server card, and the tone of the whole: `error`
 * when a step or the *arr's test of it failed, `warning` when something was skipped,
 * the *arr skips jack's indexer for now, or the backend left a message (a restart
 * it still needs), `ok` otherwise.
 */
export function registrationSummary(registration: DestinationRegistration, now = Date.now()): { parts: RegistrationPart[], tone: RegistrationTone } {
  if (registration.reason === 'downloads-off')
    return { parts: [{ text: 'skipped (downloads off)', tone: 'warning' }], tone: 'warning' }
  const paused = indexerPause(registration, now) !== null
  const steps = [
    { kind: 'indexer', label: 'indexer', step: registration.indexer, test: registration.indexerTest },
    { kind: 'downloadClient', label: 'download client', step: registration.downloadClient, test: registration.clientTest },
  ] as const
  const parts = steps.map(({ kind, label, step, test }): RegistrationPart => {
    const tone = registrationStepTone(kind, step, test, paused)
    return { text: `${label} ${partWords(kind, step, test, tone)}`, tone }
  })
  let tone: RegistrationTone = 'ok'
  if (parts.some(p => p.tone === 'error'))
    tone = 'error'
  else if (parts.some(p => p.tone === 'warning') || registration.message)
    tone = 'warning'
  return { parts, tone }
}

/**
 * One registration step in words, for the result after a save: what jack did and
 * what the *arr's test said. `arr` is the server's name, and `pausedUntil` (indexer
 * only) the end of the *arr's pause in words, as formatPauseEnd gives it.
 */
// `pausedFor`: "until 17:36" when the *arr says until when, "for a while" when it doesn't, null when not paused.
export function registrationStepDetail(kind: RegistrationKind, step: RegistrationStep, test: RegistrationTest, arr: string, pausedFor: string | null = null): string {
  if (step.status === 'failed')
    return step.error ? `jack couldn't add it: ${step.error}` : 'jack couldn\'t add it.'
  if (step.status === 'skipped')
    return step.reason === 'client-failed' ? 'Skipped, because the download client failed.' : 'Skipped, because downloads are off.'
  const pause = kind === 'indexer' && pausedFor ? `${arr} is skipping it ${pausedFor}.` : null
  if (test === 'failed')
    return pause ? `Added, but ${arr}'s test failed. ${pause}` : `Added, but ${arr}'s test failed.`
  if (pause)
    return `Added, but ${pause}`
  if (test === 'ok')
    return `Added. ${arr}'s test passed.`
  return waitsForRestart(kind, step, test) ? 'Added. Works after you restart the jack container.' : `Added. ${arr} hasn't tested it yet.`
}

/**
 * The headline of a registration, as the result after a save and the toast after
 * Register again word it: set up, the *arr skipping jack's indexer for now, or the
 * backend's message about what failed or still needs doing.
 */
export function registrationHeadline(registration: DestinationRegistration, server: { name: string, type: string }, now = Date.now()): { tone: RegistrationTone, title: string, description?: string } {
  const { name } = server
  const { tone } = registrationSummary(registration, now)
  const pause = indexerPauseText(server, registration, now)
  if (tone === 'ok') {
    const tested = registration.indexerTest === 'ok' && registration.clientTest === 'ok'
    return { tone, title: `jack is set up in ${name}.`, description: tested ? `${name} tested jack's indexer and download client, and both work.` : undefined }
  }
  if (pause && !registration.message && tone === 'warning')
    return { tone, title: pause.title, description: pause.detail }
  return {
    tone,
    title: registration.message ?? `jack couldn't finish setting itself up in ${name}.`,
    description: pause ? `${pause.title} ${pause.detail}` : undefined,
  }
}

// The backend's messages name the setting to change ("…in Address Radarr/Sonarr use
// to reach jack."), so a result can link straight to it.
const ADDRESS_SETTING = 'Address Radarr/Sonarr use to reach jack'

/** A link to the setting that fixes what a registration reports, if there is one. */
export function registrationFix(registration: DestinationRegistration): { section: SettingsSectionId, label: string } | null {
  if (registration.reason === 'downloads-off')
    return { section: 'downloads', label: 'Turn on downloads' }
  if (registration.message?.includes(ADDRESS_SETTING))
    return { section: 'internal-url', label: 'Change the address' }
  return null
}

// Radarr/Sonarr poll jack's download client about once a minute, but reach its
// indexer only on their RSS sync (every 15 min by default), so silence counts as
// "never" only this long after jack added itself.
export const ARR_CONTACT_GRACE_MS = 10 * 60_000

export type ArrContact
  = | { state: 'reached', at: string }
    | { state: 'waiting' }
    | { state: 'never' }
    | { state: 'unknown' }

/** Whether this Radarr/Sonarr has used the key jack gave it, as of `now`. */
export function arrContact(server: ServerRegistrationFields, now: number): ArrContact {
  if (server.lastContactAt)
    return { state: 'reached', at: server.lastContactAt }
  const registration = server.registration
  // Nothing was added, so the *arr has nothing to reach jack with.
  if (!registration || (registration.indexer.status !== 'ok' && registration.downloadClient.status !== 'ok'))
    return { state: 'unknown' }
  const at = Date.parse(registration.at)
  if (Number.isNaN(at))
    return { state: 'unknown' }
  return now - at >= ARR_CONTACT_GRACE_MS ? { state: 'never' } : { state: 'waiting' }
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function formatTimeAgo(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then))
    return ''
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1)
    return 'just now'
  if (minutes < 60)
    return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}
