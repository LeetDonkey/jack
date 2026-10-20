import { describe, expect, test } from 'bun:test'
import { canSealSession, MIN_SESSION_KEY_LENGTH, MISSING_KEY_MESSAGE, missingKeyMessage } from './session-key'

const KEY_32 = 'a'.repeat(MIN_SESSION_KEY_LENGTH)

describe('canSealSession', () => {
  test('needs at least 32 characters', () => {
    expect(canSealSession(KEY_32)).toBe(true)
    expect(canSealSession('a'.repeat(31))).toBe(false)
    expect(canSealSession('')).toBe(false)
  })

  test('anything but a string can\'t seal', () => {
    expect(canSealSession(undefined)).toBe(false)
    expect(canSealSession(null)).toBe(false)
    expect(canSealSession(1234567890)).toBe(false)
  })
})

describe('missingKeyMessage', () => {
  test('both keys empty, as Unraid passes empty template fields, is reported', () => {
    expect(missingKeyMessage({ managementKey: '', sessionKey: '' })).toBe(MISSING_KEY_MESSAGE)
  })

  test('a session key too short to seal the cookie is reported', () => {
    expect(missingKeyMessage({ managementKey: '', sessionKey: 'a'.repeat(31) })).toBe(MISSING_KEY_MESSAGE)
  })

  test('a Management key needs no session key', () => {
    expect(missingKeyMessage({ managementKey: 'the-key', sessionKey: '' })).toBeNull()
  })

  test('a session key of 32 characters lets jack-ui ask for the key', () => {
    expect(missingKeyMessage({ managementKey: '', sessionKey: KEY_32 })).toBeNull()
  })

  test('the message names both template fields and what to do', () => {
    expect(MISSING_KEY_MESSAGE).toContain('Management key')
    expect(MISSING_KEY_MESSAGE).toContain('Session key')
    expect(MISSING_KEY_MESSAGE).toContain('at least 32 characters')
  })
})
