import type { AuthState } from '~/composables/useAuth'
import { describe, expect, test } from 'bun:test'
import { authScreenChecksAgain } from './auth-screen'

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

  test('the key form waits for the user', () => {
    expect(authScreenChecksAgain({ status: 'needs-key', mode: 'cookie' })).toBe(false)
  })

  test('nothing to check while loading or signed in', () => {
    expect(authScreenChecksAgain({ status: 'loading', mode: null })).toBe(false)
    expect(authScreenChecksAgain({ status: 'ok', mode: 'env' })).toBe(false)
  })
})
