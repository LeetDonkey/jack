import { describe, expect, test } from 'bun:test'
import { securityFieldErrors } from './security-form'

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
