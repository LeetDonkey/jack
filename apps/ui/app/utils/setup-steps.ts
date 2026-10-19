import type { DestinationRegistration, OverviewServerItem } from '~/types/management'
import { isDefaultInternalUrl } from './internal-url'

/**
 * The steps of the dashboard's setup card, decided from what jack reports. The
 * composable useSetupStatus feeds these with the loaded data and the choices the
 * user made on the card.
 */

// done/open are the usual pair. `check` is the amber "check this" for a value that
// may be right as it is, or that a Radarr/Sonarr test says is wrong. `skipped` is a
// step the user opted out of, and `pending` a step that is still being decided (a
// server that is still connecting, or jack still adding itself to it). `untested` is
// a value nothing has tested yet and nothing needs doing about: it isn't done, and
// a test decides it later.
export type SetupStepState = 'done' | 'open' | 'check' | 'pending' | 'untested' | 'skipped'

/** What jack reports about one Radarr/Sonarr, as the card shows it. */
export interface ServerNote {
  id: string
  name: string
  message: string
}

export interface InternalUrlStep {
  state: SetupStepState
  // Why the step is in its state:
  // - `reached`: a Radarr/Sonarr test reached jack at the address.
  // - `failed`: a test failed, and none reached jack.
  // - `share-only`: the user only shares, so Radarr/Sonarr never call jack.
  // - `default`: the default address, which only works on the jack Docker network.
  // - `untestable`: jack adds itself to none of the Radarr/Sonarr that receive
  //   downloads, so nothing tests the address; the user can confirm it.
  // - `confirmed`: the same, and the user confirmed this address.
  // - `untested`: no test yet; one runs when jack adds itself to a Radarr/Sonarr.
  reason: 'reached' | 'failed' | 'share-only' | 'default' | 'untestable' | 'confirmed' | 'untested'
  // Servers whose own test reached jack at the internal URL.
  reachedBy: string[]
  // Servers whose test of jack failed, listed only while none reached it.
  failures: ServerNote[]
  // With `untestable` and `confirmed`: the servers that receive downloads but that
  // jack doesn't add itself to.
  manual: string[]
}

export interface ServerStep {
  state: SetupStepState
  // Why the step is open or pending: no server at all, none in the role the user
  // needs (receiving downloads, or sharing for someone who only shares), none of
  // them can be reached, jack is still adding itself to them, downloads are off so
  // jack added nothing, or jack couldn't add its download client or indexer to any
  // of them.
  reason: 'none' | 'no-destination' | 'no-source' | 'unreachable' | 'registering' | 'downloads-off' | 'not-added' | null
  // The servers behind the state.
  names: string[]
  // With `not-added`: what jack couldn't add to each of them.
  problems: ServerNote[]
}

export const isSetupStepDone = (state: SetupStepState) => state === 'done' || state === 'skipped'

const names = (servers: Array<{ name: string }>) => servers.map(s => s.name)

// Either of the *arr's tests passing means it reached jack at the internal URL. The
// indexer test counts too: it is the only one that runs while jack still needs a
// restart to serve its download client.
const reachedJack = (r: DestinationRegistration) => r.clientTest === 'ok' || r.indexerTest === 'ok'
const testFailed = (r: DestinationRegistration) => r.clientTest === 'failed' || r.indexerTest === 'failed'

const TRAILING_SLASHES = /\/+$/

/** Whether two internal URLs are the same address, ignoring spaces and trailing slashes. */
export function sameInternalUrl(a: string, b: string): boolean {
  const clean = (url: string) => url.trim().replace(TRAILING_SLASHES, '')
  return clean(a) === clean(b)
}

export interface InternalUrlStepInput {
  internalUrl: string
  servers: readonly OverviewServerItem[]
  // Whether jack adds itself to this server; undefined while that isn't known.
  autoRegisters: (id: string) => boolean | undefined
  shareOnly: boolean
  // The address the user confirmed on the card, if any.
  confirmedUrl: string | null
}

/**
 * Step 1, the address Radarr/Sonarr use to reach jack. Only a Radarr/Sonarr test,
 * or the user's word where jack can't test, marks it done. An address that merely
 * differs from the default is `untested` until a test says more.
 */
export function setupInternalUrlStep(input: InternalUrlStepInput): InternalUrlStep {
  const step = (state: SetupStepState, reason: InternalUrlStep['reason'], extra: Partial<Pick<InternalUrlStep, 'reachedBy' | 'failures' | 'manual'>> = {}): InternalUrlStep =>
    ({ state, reason, reachedBy: [], failures: [], manual: [], ...extra })

  if (input.shareOnly)
    return step('skipped', 'share-only')

  // Destinations with what jack registered in them this boot, and the *arr's tests.
  const registered = input.servers.flatMap(server =>
    server.destination && server.registration ? [{ server, registration: server.registration }] : [])

  const reachedBy = names(registered.filter(({ registration }) => reachedJack(registration)).map(({ server }) => server))
  if (reachedBy.length)
    return step('done', 'reached', { reachedBy })

  const failures = registered
    .filter(({ registration }) => testFailed(registration))
    .map(({ server, registration }) => ({
      id: server.id,
      name: server.name,
      message: registration.message ?? `${server.name} couldn't reach jack.`,
    }))
  if (failures.length)
    return step('check', 'failed', { failures })

  const confirmed = input.confirmedUrl !== null && sameInternalUrl(input.confirmedUrl, input.internalUrl)
  if (isDefaultInternalUrl(input.internalUrl) && !confirmed)
    return step('check', 'default')

  // jack tests the address only in the Radarr/Sonarr it adds itself to. When it adds
  // itself to none of those that receive downloads, no test is coming.
  const receivers = input.servers.filter(s => s.destination && s.initialized)
  if (receivers.length && receivers.every(s => input.autoRegisters(s.id) === false)) {
    const manual = names(receivers)
    return confirmed ? step('done', 'confirmed', { manual }) : step('check', 'untestable', { manual })
  }
  return step('untested', 'untested')
}

export function setupDownloadsStep(downloadsOn: boolean, shareOnly: boolean): SetupStepState {
  if (downloadsOn)
    return 'done'
  return shareOnly ? 'skipped' : 'open'
}

/**
 * The one step that offers "I only share": the first open step it answers, so the
 * card never shows the same choice twice. Steps 2 (downloads off) and 3 (nothing
 * receives downloads) both ask for something only a downloader needs. None while a
 * Radarr/Sonarr receives downloads: "I only share" counts only without one.
 */
export function shareOnlyOfferStep(downloadsStep: SetupStepState, serverStep: Pick<ServerStep, 'reason'>, destinations: number): 'downloads' | 'servers' | null {
  if (destinations > 0)
    return null
  if (downloadsStep === 'open')
    return 'downloads'
  return serverStep.reason === 'no-destination' ? 'servers' : null
}

// What jack couldn't add to a server it registered in.
function notAddedProblem(server: OverviewServerItem, registration: DestinationRegistration): ServerNote {
  // Registered while downloads were off, and not again since they were turned on.
  if (registration.reason === 'downloads-off')
    return { id: server.id, name: server.name, message: `jack added nothing to ${server.name} while downloads were off. Click Register again on its card under Radarr & Sonarr.` }
  const part = registration.downloadClient.status === 'ok' ? 'indexer' : 'download client'
  return { id: server.id, name: server.name, message: registration.message ?? `jack couldn't add its ${part} to ${server.name}.` }
}

/** Whether jack added both its download client and its indexer to this server. */
function fullyAdded(registration: DestinationRegistration | null): boolean {
  return registration?.downloadClient.status === 'ok' && registration.indexer.status === 'ok'
}

export interface ServerStepInput {
  servers: readonly OverviewServerItem[]
  autoRegisters: (id: string) => boolean | undefined
  shareOnly: boolean
  downloadsOn: boolean
}

/**
 * Step 3, a Radarr/Sonarr in the role the user needs: one that receives downloads,
 * with jack's download client and indexer in it, or one that shares its library for
 * someone who only shares.
 */
export function setupServerStep(input: ServerStepInput): ServerStep {
  const step = (state: SetupStepState, reason: ServerStep['reason'], servers: Array<{ name: string }> = [], problems: ServerNote[] = []): ServerStep =>
    ({ state, reason, names: names(servers), problems })

  const items = input.servers
  if (items.length === 0)
    return step('open', 'none')
  // Downloading needs a server that receives downloads. Someone who only shares
  // needs one that shares its library instead.
  const relevant = items.filter(s => input.shareOnly ? s.source : s.destination)
  if (relevant.length === 0)
    return step('open', input.shareOnly ? 'no-source' : 'no-destination')
  const connected = relevant.filter(s => s.initialized)
  if (connected.length === 0) {
    // No error yet means still handshaking, as right after jack starts. That is
    // not something to do, so it never reopens a hidden card.
    const connecting = relevant.filter(s => !s.initializationError)
    if (connecting.length)
      return step('pending', null, connecting)
    return step('open', 'unreachable', relevant)
  }
  if (input.shareOnly)
    return step('done', null, connected)

  // Receiving needs jack's download client and its indexer in the *arr: without the
  // indexer, Radarr/Sonarr can't find friends' releases. A server jack doesn't add
  // itself to (auto-register off) is the user's to set up, so it counts as it is.
  const receiving = connected.filter(s => fullyAdded(s.registration) || input.autoRegisters(s.id) === false)
  if (receiving.length)
    return step('done', null, receiving)
  const registering = connected.filter(s => !s.registration)
  if (registering.length)
    return step('pending', 'registering', registering)
  if (!input.downloadsOn)
    return step('open', 'downloads-off', connected)
  return step('open', 'not-added', connected, connected.flatMap(s => s.registration ? [notAddedProblem(s, s.registration)] : []))
}
