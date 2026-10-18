import process from 'node:process'

// jack-ui's own build, for "UI build" in Settings -> Advanced -> About. The
// Dockerfile turns the REVISION and BUILD_DATE build args into these variables.
// They're read on each request, not through runtimeConfig, so the image needs
// no nuxt.config entry. Checked the way jack checks its own (lib/build.ts):
// anything unusable becomes null, which About shows as "unknown build".
const REVISION = /^[\w.-]{1,64}$/
const MAX_DATE_LENGTH = 40

function revisionOf(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return REVISION.test(trimmed) ? trimmed : null
}

function dateOf(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed || trimmed.length > MAX_DATE_LENGTH)
    return null
  const ms = Date.parse(trimmed)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

export default defineEventHandler(async (event) => {
  // Only for a signed-in browser, like everything under /api/management.
  const { key } = await resolveKey(event)
  if (!key)
    throw createError({ statusCode: 401, statusMessage: 'not authenticated' })

  return {
    revision: revisionOf(process.env.JACK_BUILD_REVISION),
    buildDate: dateOf(process.env.JACK_BUILD_DATE),
  }
})
