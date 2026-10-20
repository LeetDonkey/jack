import { missingKeyMessage } from '../utils/session-key'

// Cookie-mode login: validate the supplied key against the management API, then
// seal it into an HttpOnly/Secure/SameSite=Strict cookie. No-op (400) in env mode,
// where the BFF already injects the key.
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const config = useRuntimeConfig(event)
  if (config.managementKey)
    throw createError({ statusCode: 400, statusMessage: 'login is disabled: the UI injects MANAGEMENT_KEY from its environment' })

  // No session key to keep the key in: say so before asking jack.
  const missingKey = missingKeyMessage(config)
  if (missingKey)
    throw createError({ statusCode: 500, statusMessage: missingKey })

  const body = await readBody<{ key?: string }>(event)
  const key = body?.key?.trim()
  if (!key)
    throw createError({ statusCode: 400, statusMessage: 'key is required' })

  const probe = await probeUpstream(event, key)
  if (!probe.reachable)
    throw createError({ statusCode: 503, statusMessage: 'management API is unreachable' })
  if (probe.status === 401)
    throw createError({ statusCode: 401, statusMessage: 'invalid management key' })
  if (probe.status !== 200)
    throw createError({ statusCode: 502, statusMessage: `unexpected management API status ${probe.status}` })

  const session = await getManagementSession(event)
  await session.update({ key })
  return { status: 'ok' as const }
})
