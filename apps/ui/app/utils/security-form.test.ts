import { describe, expect, test } from 'bun:test'
import { customListCount, hasListError, ignoredEntriesNote, ignoredOnField, opensExceptions, securityCanSave, securityFieldErrors, securityLink } from './security-form'

const fields = new Set(['trustedProxies', 'neverBan', 'maxFailures'])

describe('securityFieldErrors', () => {
  test('puts an issue on a list entry on its field, naming the entry', () => {
    const errors = securityFieldErrors(
      [{ field: 'trustedProxies.1', message: 'Enter an IP address or range' }],
      { trustedProxies: ['172.18.0.0/16', 'npm'] },
      fields,
    )
    expect(errors).toEqual([{ name: 'trustedProxies', message: '"npm": Enter an IP address or range' }])
  })

  test('keeps a message that names the entry already', () => {
    const errors = securityFieldErrors([{ field: 'neverBan.0', message: '"x" is not an address' }], { neverBan: ['x'] }, fields)
    expect(errors).toEqual([{ name: 'neverBan', message: '"x" is not an address' }])
  })

  test('maps a plain field and keeps the first issue per field', () => {
    const errors = securityFieldErrors(
      [
        { field: 'maxFailures', message: 'Too big' },
        { field: 'neverBan.0', message: 'Bad' },
        { field: 'neverBan.1', message: 'Also bad' },
      ],
      { neverBan: ['a', 'b'] },
      fields,
    )
    expect(errors).toEqual([{ name: 'maxFailures', message: 'Too big' }, { name: 'neverBan', message: '"a": Bad' }])
  })

  test('leaves out issues on fields the form does not show', () => {
    expect(securityFieldErrors([{ field: 'arrApiAlsoAllowed.0', message: 'Bad' }, { field: null, message: 'Body' }], {}, fields)).toEqual([])
  })
})

describe('ignoredOnField', () => {
  const entries = [
    { field: 'trustedProxies', value: 'Nginx Proxy Manager' },
    { field: 'neverBan', value: 'tailscale' },
    { field: 'trustedProxies', value: 'npm' },
    { field: 'trustedProxies', value: 'npm' },
  ] as const

  test('lists one field\'s entries in order, each once', () => {
    expect(ignoredOnField(entries, 'trustedProxies')).toEqual(['Nginx Proxy Manager', 'npm'])
    expect(ignoredOnField(entries, 'arrApiAlsoAllowed')).toEqual([])
  })

  test('is empty for a jack that reports none', () => {
    expect(ignoredOnField(undefined, 'neverBan')).toEqual([])
  })
})

describe('ignoredEntriesNote', () => {
  test('quotes each entry, says why jack ignores it and that saving removes it', () => {
    expect(ignoredEntriesNote(['Nginx Proxy Manager'])).toBe('jack ignores "Nginx Proxy Manager", because it isn\'t an IP address or range. Saving the security settings removes it.')
    expect(ignoredEntriesNote(['npm', 'tailscale'])).toBe('jack ignores "npm" and "tailscale", because they aren\'t IP addresses or ranges. Saving the security settings removes them.')
    expect(ignoredEntriesNote(['a', 'b', '42'])).toBe('jack ignores "a", "b", and "42", because they aren\'t IP addresses or ranges. Saving the security settings removes them.')
  })
})

describe('securityCanSave', () => {
  // Any save drops every ignored entry, so they alone make a save worth doing.
  test('allows a save for a change, or for stored entries jack ignores', () => {
    expect(securityCanSave(true, [])).toBe(true)
    expect(securityCanSave(false, [{ field: 'neverBan', value: 'tailscale' }])).toBe(true)
  })

  test('has nothing to save without either', () => {
    expect(securityCanSave(false, [])).toBe(false)
    expect(securityCanSave(false, undefined)).toBe(false)
  })
})

describe('customListCount', () => {
  const lists = { trustedProxies: '172.18.0.0/16', neverBan: ' , ', arrApiAlsoAllowed: '100.64.0.0/10' }

  test('counts the lists on screen that hold an entry', () => {
    expect(customListCount(lists, new Set(['trustedProxies', 'neverBan', 'arrApiAlsoAllowed']))).toBe(2)
  })

  test('leaves out a list hidden behind its switch', () => {
    expect(customListCount(lists, new Set(['trustedProxies', 'neverBan']))).toBe(1)
    expect(customListCount({ trustedProxies: '', neverBan: '', arrApiAlsoAllowed: '' }, new Set(['trustedProxies']))).toBe(0)
  })
})

describe('hasListError', () => {
  test('is true only for an error on an address list', () => {
    expect(hasListError([{ name: 'maxFailures' }, { name: 'neverBan' }])).toBe(true)
    expect(hasListError([{ name: 'windowMinutes' }, {}])).toBe(false)
    expect(hasListError([])).toBe(false)
  })
})

describe('securityLink', () => {
  test('points at a part of the Security section on the Sharing tab', () => {
    expect(securityLink('bans')).toBe('/settings/sharing#security-bans')
    expect(securityLink('apis')).toBe('/settings/sharing#security-apis')
    expect(securityLink('arrOutsideLan')).toBe('/settings/sharing#security-arr-outside-lan')
  })
})

describe('opensExceptions', () => {
  // The group starts closed, so a link to it or to a field in it must open it.
  test('is true for a link into Reverse proxy and exceptions', () => {
    expect(opensExceptions('#security-exceptions')).toBe(true)
    expect(opensExceptions('#security-arr-outside-lan')).toBe(true)
    expect(opensExceptions(new URL(securityLink('arrOutsideLan'), 'http://x').hash)).toBe(true)
  })

  test('is false for the other parts of the section and for no hash', () => {
    expect(opensExceptions('#security')).toBe(false)
    expect(opensExceptions('#security-apis')).toBe(false)
    expect(opensExceptions('')).toBe(false)
    expect(opensExceptions('#%E0%A4%A')).toBe(false)
  })
})
