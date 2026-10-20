import type { AuthState } from '~/composables/useAuth'

/** How often a connection screen asks /api/ping again. */
export const AUTH_CHECK_EVERY_MS = 5_000

/**
 * Whether the screen for this auth state checks again by itself and opens the app
 * once jack answers. jack starting, restarting or being updated, and jack-ui's
 * own server restarting, clear up without the user. A rejected or missing key is
 * fixed in a template, and Apply restarts that container, so the next check finds
 * the key in place. The key form (cookie mode) waits for the user to unlock.
 */
export function authScreenChecksAgain(state: AuthState): boolean {
  return state.status === 'disabled' || state.status === 'error'
}
