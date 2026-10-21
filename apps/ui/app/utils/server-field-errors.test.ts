import type { KeptFieldError } from './server-field-errors'
import { describe, expect, test } from 'bun:test'
import { fieldSnapshot, reconcileFieldErrors, replaceFieldErrors, valueAtPath, withoutKeptErrors } from './server-field-errors'

const TOO_SMALL = 'Too small: expected number to be >=1'

function kept(name: string, value: unknown, message = TOO_SMALL): KeptFieldError {
  return { name, message, value: fieldSnapshot(value) }
}

describe('valueAtPath', () => {
  test('reads a field and a nested field by its form name', () => {
    const state = { rssMaxAgeDays: 0, schedule: [{ downloadMb: 2 }], webhooks: [{ type: 'discord', url: null }] }
    expect(valueAtPath(state, 'rssMaxAgeDays')).toBe(0)
    expect(valueAtPath(state, 'schedule.0.downloadMb')).toBe(2)
    expect(valueAtPath(state, 'webhooks.0')).toEqual({ type: 'discord', url: null })
    expect(valueAtPath(state, 'schedule.3.downloadMb')).toBeUndefined()
  })
})

describe('reconcileFieldErrors', () => {
  const values: Record<string, unknown> = { rssMaxAgeDays: 0, rssMaxItems: 5 }
  const snapshotOf = (name: string) => fieldSnapshot(values[name])

  test('puts jack\'s error back after the form\'s own check dropped it', () => {
    // UForm re-checked rssMaxAgeDays 300 ms after typing and found nothing.
    const result = reconcileFieldErrors([], [kept('rssMaxAgeDays', 0)], snapshotOf)
    expect(result.errors).toEqual([{ name: 'rssMaxAgeDays', message: TOO_SMALL }])
    expect(result.kept).toHaveLength(1)
  })

  test('leaves the form alone while jack\'s error is still there', () => {
    const current = [{ name: 'rssMaxAgeDays', message: TOO_SMALL, id: 'v-1' }]
    expect(reconcileFieldErrors(current, [kept('rssMaxAgeDays', 0)], snapshotOf).errors).toBeNull()
  })

  test('keeps the form\'s own errors next to jack\'s', () => {
    const own = { name: 'rssMaxItems', message: 'Enter a number.' }
    expect(reconcileFieldErrors([own], [kept('rssMaxAgeDays', 0)], snapshotOf).errors)
      .toEqual([own, { name: 'rssMaxAgeDays', message: TOO_SMALL }])
  })

  test('drops jack\'s error once its field has changed', () => {
    const current = [{ name: 'rssMaxAgeDays', message: TOO_SMALL }]
    const result = reconcileFieldErrors(current, [kept('rssMaxAgeDays', 3)], snapshotOf)
    expect(result).toEqual({ kept: [], errors: [] })
    // Already gone from the form: nothing to change there.
    expect(reconcileFieldErrors([], [kept('rssMaxAgeDays', 3)], snapshotOf)).toEqual({ kept: [], errors: null })
  })

  test('a changed field keeps an error of the form\'s own', () => {
    const own = { name: 'rssMaxAgeDays', message: 'Enter a whole number.' }
    expect(reconcileFieldErrors([own], [kept('rssMaxAgeDays', 3)], snapshotOf).errors).toBeNull()
  })
})

describe('replaceFieldErrors', () => {
  test('replaces the errors on the named fields and keeps the rest', () => {
    const current = [{ name: 'url', message: 'old' }, { name: 'instanceName', message: 'own' }, { message: 'no field' }]
    expect(replaceFieldErrors(current, [{ name: 'url', message: 'jack says' }]))
      .toEqual([{ name: 'instanceName', message: 'own' }, { message: 'no field' }, { name: 'url', message: 'jack says' }])
  })
})

describe('withoutKeptErrors', () => {
  test('removes only the kept errors', () => {
    const own = { name: 'rssMaxItems', message: 'Enter a number.' }
    const current = [own, { name: 'rssMaxAgeDays', message: TOO_SMALL }]
    expect(withoutKeptErrors(current, [kept('rssMaxAgeDays', 0)])).toEqual([own])
    expect(withoutKeptErrors([own], [kept('rssMaxAgeDays', 0)])).toBeNull()
  })
})
