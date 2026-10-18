import { describe, expect, test } from 'bun:test'
import { minInUnit, msToUnit, unitToMs } from './duration-units'

describe('msToUnit', () => {
  test('shows the downloads defaults as round numbers', () => {
    expect(msToUnit(86_400_000, 'h')).toBe(24)
    expect(msToUnit(60_000, 's')).toBe(60)
    expect(msToUnit(1000, 's')).toBe(1)
    expect(msToUnit(1_800_000, 'min')).toBe(30)
    expect(msToUnit(30_000, 's')).toBe(30)
    expect(msToUnit(60_000, 'min')).toBe(1)
  })

  test('keeps fractions, at most three decimals', () => {
    expect(msToUnit(90_000, 'min')).toBe(1.5)
    expect(msToUnit(1500, 's')).toBe(1.5)
    expect(msToUnit(1000, 'min')).toBe(0.017)
    expect(msToUnit(1, 'h')).toBe(0)
  })

  test('zero stays zero', () => {
    expect(msToUnit(0, 'h')).toBe(0)
  })
})

describe('unitToMs', () => {
  test('converts back to milliseconds', () => {
    expect(unitToMs(24, 'h')).toBe(86_400_000)
    expect(unitToMs(12, 'h')).toBe(43_200_000)
    expect(unitToMs(1.5, 'min')).toBe(90_000)
    expect(unitToMs(45, 's')).toBe(45_000)
    expect(unitToMs(0, 's')).toBe(0)
  })

  test('always gives whole milliseconds', () => {
    expect(unitToMs(0.0005, 's')).toBe(1)
    expect(unitToMs(0.017, 'min')).toBe(1020)
    expect(unitToMs(0.333, 'h')).toBe(1_198_800)
    for (const value of [0.001, 0.1, 0.123, 1.999, 2.5])
      expect(Number.isInteger(unitToMs(value, 'min'))).toBe(true)
  })

  test('round-trips whole units exactly', () => {
    for (const ms of [1000, 30_000, 60_000, 1_800_000, 86_400_000])
      expect(unitToMs(msToUnit(ms, 's'), 's')).toBe(ms)
    for (const ms of [60_000, 90_000, 1_800_000, 86_400_000])
      expect(unitToMs(msToUnit(ms, 'min'), 'min')).toBe(ms)
    expect(unitToMs(msToUnit(43_200_000, 'h'), 'h')).toBe(43_200_000)
  })
})

describe('minInUnit', () => {
  test('the backend minimum of 1000 ms is 1 s', () => {
    expect(minInUnit(1000, 's')).toBe(1)
  })

  test('rounds up, so the smallest entry never goes below the minimum', () => {
    expect(minInUnit(1000, 'min')).toBe(0.017)
    expect(unitToMs(minInUnit(1000, 'min'), 'min')).toBeGreaterThanOrEqual(1000)
    expect(minInUnit(1000, 'h')).toBe(0.001)
    expect(unitToMs(minInUnit(1000, 'h'), 'h')).toBeGreaterThanOrEqual(1000)
  })

  test('zero is zero', () => {
    expect(minInUnit(0, 'h')).toBe(0)
  })
})
