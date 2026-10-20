import { missingKeyMessage } from '../utils/session-key'

// The UI's four-state auth probe (mirrors the design doc):
//   ok          → key valid, management API up
//   needs-key   → cookie mode, no/invalid key → prompt for it
//   disabled    → jack-ui can't reach the management API; `reason` says why
//                 (dns, down, timeout) and `url` where it looked
//   error       → env-injected key rejected (`reason: 'unauthorized'`), no key
//                 to use and no session key to ask for one with
//                 (`reason: 'session-key'`), or an unexpected upstream status
// Always a 200 once the server is up: the image's healthcheck relies on it.
export default defineEventHandler(async (event) => {
  // Before jack is asked: the login form couldn't keep a key without a session
  // key, so it would only fail.
  const missingKey = missingKeyMessage(useRuntimeConfig(event))
  if (missingKey)
    return { status: 'error' as const, mode: 'cookie' as const, reason: 'session-key' as const, message: missingKey }

  const { key, mode } = await resolveKey(event)
  const probe = await probeUpstream(event, key)

  if (!probe.reachable)
    return { status: 'disabled' as const, mode, reason: probe.reason, url: upstreamOrigin(event) }

  if (probe.status === 200)
    return { status: 'ok' as const, mode }

  if (probe.status === 401) {
    if (mode === 'env') {
      return {
        status: 'error' as const,
        mode,
        reason: 'unauthorized' as const,
        message: 'The Management key in the jack-ui template doesn\'t match the one in the jack template.',
      }
    }
    return { status: 'needs-key' as const, mode }
  }

  return { status: 'error' as const, mode, message: `jack answered with an unexpected status (${probe.status}).` }
})
