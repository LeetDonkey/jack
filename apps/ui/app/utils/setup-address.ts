import type { InternalUrlStep, ServerNote, ServerStep } from './setup-steps'
import type { DestinationRegistration, OverviewServerItem } from '~/types/management'

/**
 * Radarr/Sonarr test a new download client or indexer before they create it, and
 * forceSave doesn't skip that test. So on a first registration a wrong address makes
 * jack's own add step fail, and the *arr's tests of jack never run (both read
 * `skipped`). This finds those failures, so the setup card points at the address
 * instead of calling it untested.
 */

export type AddressProblem = 'resolve' | 'refused' | 'unreachable' | 'timeout'

// The network error *arr reports when its test of jack's address failed, as in
// "Unable to connect to qBittorrent (Name does not resolve (jack:5225))". jack's own
// errors reaching the *arr read differently ("Unable to connect. Is the computer
// able to access the url?"), and an HTTP error means the *arr reached something.
const PROBLEMS: Array<[AddressProblem, RegExp]> = [
  ['resolve', /name or service not known|no such host|name does not resolve|could not resolve|temporary failure in name resolution|nodename nor servname|resource temporarily unavailable|no address associated/i],
  ['refused', /connection refused|actively refused|econnrefused/i],
  ['unreachable', /no route to host|network is unreachable|host is unreachable|ehostunreach|enetunreach/i],
  // Includes jack's own "The request timed out": the *arr answered jack a moment
  // earlier, so a create that hangs is the *arr still trying the address.
  ['timeout', /timed out|timeout|task was canceled|operation was canceled/i],
]

// The backend's own explanations name this setting.
const ADDRESS_SETTING = 'Address Radarr/Sonarr use to reach jack'

/** Why a registration step failed, when the cause is the *arr not reaching jack's address. */
export function registrationAddressProblem(registration: DestinationRegistration): AddressProblem | null {
  if (registration.reason === 'downloads-off')
    return null
  const errors = [registration.downloadClient, registration.indexer]
    .filter(step => step.status === 'failed' && step.error)
    .map(step => step.error!)
  for (const error of errors) {
    const match = PROBLEMS.find(([, pattern]) => pattern.test(error))
    if (match)
      return match[0]
  }
  return null
}

function describeAddress(internalUrl: string): { host: string, hostPort: string } {
  try {
    const url = new URL(internalUrl)
    return { host: url.hostname, hostPort: url.host }
  }
  catch {
    return { host: internalUrl, hostPort: internalUrl }
  }
}

const BR0_HINT = (name: string) => `If ${name} runs on br0, turn on host access to custom networks in Unraid's Docker settings.`

/** The card's sentence for a server that couldn't reach jack while jack added itself. */
export function addressProblemMessage(problem: AddressProblem, name: string, internalUrl: string): string {
  const { host, hostPort } = describeAddress(internalUrl)
  const failed = `jack couldn't add itself to ${name}`
  switch (problem) {
    case 'resolve':
      return `${failed}: ${name} can't find ${host}. Use your server's IP address instead.`
    case 'refused':
      return `${failed}: ${name} reached ${host}, but nothing answered on ${hostPort}. Check the port.`
    case 'unreachable':
      return `${failed}: ${name} has no route to ${host}. Check the address. ${BR0_HINT(name)}`
    case 'timeout':
      return `${failed}: ${name}'s test of ${hostPort} took too long, which usually means it can't reach that address. ${BR0_HINT(name)}`
  }
}

/**
 * The receiving servers whose registration failed because they couldn't reach jack's
 * address, with what to tell the user. A message from jack that already names the
 * address setting is used as it is.
 */
export function addressFailures(servers: readonly OverviewServerItem[], internalUrl: string): ServerNote[] {
  return servers.flatMap((server) => {
    const registration = server.destination ? server.registration : null
    const problem = registration ? registrationAddressProblem(registration) : null
    if (!registration || !problem)
      return []
    const message = registration.message?.includes(ADDRESS_SETTING)
      ? registration.message
      : addressProblemMessage(problem, server.name, internalUrl)
    return [{ id: server.id, name: server.name, message }]
  })
}

/**
 * Step 1 with those failures: the address needs checking, as when a test failed. A
 * server that reached jack still settles it, and the user's confirmation doesn't
 * outweigh a server that couldn't connect.
 */
export function withAddressFailures(step: InternalUrlStep, failures: readonly ServerNote[]): InternalUrlStep {
  if (failures.length === 0 || step.reason === 'reached' || step.reason === 'share-only')
    return step
  const known = new Set(step.failures.map(f => f.id))
  return {
    ...step,
    state: 'check',
    reason: 'failed',
    failures: [...step.failures, ...failures.filter(f => !known.has(f.id))],
  }
}

/**
 * Step 3 with those failures: the *arr's raw error ("Unable to connect to
 * qBittorrent …", "Register again") would send the user the wrong way, so the step
 * points at step 1 instead.
 */
export function serverStepWithAddressFailures(step: ServerStep, failures: readonly ServerNote[]): ServerStep {
  if (step.reason !== 'not-added' || failures.length === 0)
    return step
  const failed = new Set(failures.map(f => f.id))
  return {
    ...step,
    problems: step.problems.map(problem => failed.has(problem.id)
      ? { ...problem, message: `jack adds itself to ${problem.name} once ${problem.name} can reach jack (step 1). Saving a new address tries again. After a fix in Unraid, use Register again on ${problem.name}'s card.` }
      : problem),
  }
}
