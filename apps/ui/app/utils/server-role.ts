import type { DestinationRegistration, RegistrationStep, RegistrationTest, ServerRegistrationFields } from '~/types/management'
import type { SettingsSectionId } from '~/utils/settings-links'

/** Display name for a server's `type` ("radarr" -> "Radarr"). */
export function arrName(type: string): string {
  return type === 'sonarr' ? 'Sonarr' : 'Radarr'
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

export interface RegistrationPart {
  text: string
  tone: RegistrationTone
}

/**
 * Added, but not tested. jack skips the test only for a download client it can't
 * serve yet: downloads were turned on after jack started, and the *arr can use the
 * client once the jack container restarts.
 */
function waitsForRestart(step: RegistrationStep, test: RegistrationTest): boolean {
  return step.status === 'ok' && test === 'skipped'
}

/**
 * How one registration step went. A step jack added but the *arr's own test of it
 * failed is as broken as one jack couldn't add: the *arr can't use it either way.
 */
export function registrationStepTone(step: RegistrationStep, test: RegistrationTest): RegistrationTone {
  if (step.status === 'failed' || test === 'failed')
    return 'error'
  return step.status === 'skipped' || waitsForRestart(step, test) ? 'warning' : 'ok'
}

const PART_WORDS: Record<RegistrationTone, string> = { ok: '✓', warning: 'skipped', error: 'failed' }

function part(label: string, step: RegistrationStep, test: RegistrationTest): RegistrationPart {
  const tone = registrationStepTone(step, test)
  const words = waitsForRestart(step, test) ? 'waits for a restart' : PART_WORDS[tone]
  return { text: `${label} ${words}`, tone }
}

/**
 * The "jack in Radarr: …" line on a server card, and the tone of the whole: `error`
 * when a step or the *arr's test of it failed, `warning` when something was skipped
 * or the backend left a message (a restart it still needs), `ok` otherwise.
 */
export function registrationSummary(registration: DestinationRegistration): { parts: RegistrationPart[], tone: RegistrationTone } {
  if (registration.reason === 'downloads-off')
    return { parts: [{ text: 'skipped (downloads off)', tone: 'warning' }], tone: 'warning' }
  const parts = [
    part('indexer', registration.indexer, registration.indexerTest),
    part('download client', registration.downloadClient, registration.clientTest),
  ]
  let tone: RegistrationTone = 'ok'
  if (parts.some(p => p.tone === 'error'))
    tone = 'error'
  else if (parts.some(p => p.tone === 'warning') || registration.message)
    tone = 'warning'
  return { parts, tone }
}

/**
 * One registration step in words, for the result after a save: what jack did and
 * what the *arr's test said. `arr` is the server's name.
 */
export function registrationStepDetail(step: RegistrationStep, test: RegistrationTest, arr: string): string {
  if (step.status === 'failed')
    return step.error ? `jack couldn't add it: ${step.error}` : 'jack couldn\'t add it.'
  if (step.status === 'skipped')
    return step.reason === 'client-failed' ? 'Skipped, because the download client failed.' : 'Skipped, because downloads are off.'
  if (test === 'ok')
    return `Added. ${arr}'s test passed.`
  if (test === 'failed')
    return `Added, but ${arr}'s test failed.`
  return 'Added. Works after you restart the jack container.'
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
