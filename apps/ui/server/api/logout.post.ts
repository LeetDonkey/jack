import { canSealSession } from '../utils/session-key'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  // Without a session key that can seal a cookie, jack-ui never set one, and
  // opening the session would throw.
  if (canSealSession(useRuntimeConfig(event).sessionKey)) {
    const session = await getManagementSession(event)
    await session.clear()
  }
  return { status: 'ok' as const }
})
