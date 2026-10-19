// Plain-language copy for the ways *arr's Test of jack's download client or indexer
// fails. *arr's own text names .NET exceptions ("Name or service not known
// (jack:5225)"), so the common causes are mapped to what to change in jack.

export { isNoResultsFailure } from '../../lib/servers/arr/validation'

const SETTING = 'Address Radarr/Sonarr use to reach jack'

const NAME_RESOLUTION = /name or service not known|no such host|name does not resolve|could not resolve|temporary failure in name resolution|nodename nor servname|resource temporarily unavailable|no address associated/i
const REFUSED = /connection refused|actively refused|econnrefused/i
const UNREACHABLE = /no route to host|network is unreachable|host is unreachable|ehostunreach|enetunreach/i
const TIMEOUT = /timed out|timeout|task was canceled|operation was canceled/i
const TLS = /\bssl\b|\btls\b|certificate/i
const AUTH = /authentication failure|unauthori[sz]ed|forbidden|invalid api ?key|\b401\b|\b403\b/i
const NOT_FOUND = /\b404\b|not ?found/i

function describeAddress(internalUrl: string): { host: string, hostPort: string } {
  try {
    const url = new URL(internalUrl)
    return { host: url.hostname, hostPort: url.host }
  }
  catch {
    return { host: internalUrl, hostPort: internalUrl }
  }
}

/** What to tell the user when `arrName`'s test of jack failed with `text`. */
export function explainArrTestFailure(text: string, { arrName, internalUrl }: { arrName: string, internalUrl: string }): string {
  const { host, hostPort } = describeAddress(internalUrl)
  if (NAME_RESOLUTION.test(text))
    return `${arrName} can't resolve ${host}. Use your server's IP in ${SETTING}.`
  if (REFUSED.test(text))
    return `${arrName} reached ${host}, but nothing answered on ${hostPort}. Check the port in ${SETTING}.`
  if (UNREACHABLE.test(text))
    return `${arrName} has no route to ${host}. Check ${SETTING}. If ${arrName} runs on br0, turn on host access to custom networks in Unraid's Docker settings.`
  if (TIMEOUT.test(text))
    return `${arrName} got no answer from ${hostPort}. Check ${SETTING}. If ${arrName} runs on br0, turn on host access to custom networks in Unraid's Docker settings.`
  if (TLS.test(text))
    return `${arrName} couldn't set up HTTPS to ${hostPort}. Use http:// in ${SETTING}, unless a proxy with a valid certificate sits in front of jack.`
  if (AUTH.test(text))
    return `jack rejected ${arrName}'s key. Register again to give ${arrName} a new one.`
  if (NOT_FOUND.test(text))
    return `${arrName} reached ${hostPort}, but jack didn't answer there. Check ${SETTING}.`
  return `${arrName} couldn't use jack: ${text}`
}

/** When jack itself couldn't get `arrName` to run the test. */
export function explainTestNotRun(error: string, { arrName, timedOut, timeoutSeconds, internalUrl }: { arrName: string, timedOut: boolean, timeoutSeconds: number, internalUrl: string }): string {
  if (timedOut) {
    const { hostPort } = describeAddress(internalUrl)
    return `${arrName} didn't finish testing jack within ${timeoutSeconds} seconds, so it probably can't reach ${hostPort}. Check ${SETTING}.`
  }
  return `jack couldn't ask ${arrName} to test the connection: ${error}`
}
