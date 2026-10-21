import type { AuthState } from '~/composables/useAuth'
import { describe, expect, test } from 'bun:test'
import { authScreenChecksAgain, authScreenShows } from './auth-screen'

describe('authScreenChecksAgain', () => {
  test('the screens a restart clears up check again', () => {
    const states: AuthState[] = [
      { status: 'disabled', mode: 'env', reason: 'dns', url: 'http://jack:5226' },
      { status: 'disabled', mode: 'cookie', reason: 'timeout' },
      { status: 'error', mode: null, message: 'Could not reach the UI server.' },
      { status: 'error', mode: 'env', message: 'jack answered with an unexpected status (500).' },
    ]
    for (const state of states)
      expect(authScreenChecksAgain(state)).toBe(true)
  })

  test('a rejected key checks again, since fixing a template restarts a container', () => {
    expect(authScreenChecksAgain({ status: 'error', mode: 'env', reason: 'unauthorized' })).toBe(true)
  })

  test('missing keys check again, since Apply restarts jack-ui with the new template', () => {
    expect(authScreenChecksAgain({ status: 'error', mode: 'cookie', reason: 'session-key', message: 'Management key is empty' })).toBe(true)
  })

  test('the key form waits for the user', () => {
    expect(authScreenChecksAgain({ status: 'needs-key', mode: 'cookie' })).toBe(false)
  })

  test('nothing to check while loading or signed in', () => {
    expect(authScreenChecksAgain({ status: 'loading', mode: null })).toBe(false)
    expect(authScreenChecksAgain({ status: 'ok', mode: 'env' })).toBe(false)
  })
})

describe('authScreenShows', () => {
  test('the first check shows "Connecting to jack…" only once it has taken a while', () => {
    expect(authScreenShows({ status: 'loading', mode: null }, false)).toBe(false)
    expect(authScreenShows({ status: 'loading', mode: null }, true)).toBe(true)
  })

  test('an answer shows at once', () => {
    const states: AuthState[] = [
      { status: 'disabled', mode: 'env', reason: 'timeout', url: 'http://jack:5226' },
      { status: 'needs-key', mode: 'cookie' },
      { status: 'error', mode: null, message: 'Could not reach the UI server.' },
    ]
    for (const state of states)
      expect(authScreenShows(state, false)).toBe(true)
  })
})
