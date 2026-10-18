import { describe, expect, test } from 'bun:test'
import { formatCalendarDay, formatClockOrDay, formatClockTime, formatDurationMs, formatEta, formatRate, friendStatusWords } from './format'

// Settings shows raw milliseconds (that's what the config file holds) next to this
// reading of them, so the numbers stay editable without being unreadable.
describe('formatDurationMs', () => {
  test('reads the config defaults back in human terms', () => {
    expect(formatDurationMs(1000)).toBe('1 s')
    expect(formatDurationMs(30_000)).toBe('30 s')
    expect(formatDurationMs(60_000)).toBe('1 min')
    expect(formatDurationMs(1_800_000)).toBe('30 min')
  })

  test('keeps sub-second values in milliseconds', () => {
    expect(formatDurationMs(250)).toBe('250 ms')
    expect(formatDurationMs(999)).toBe('999 ms')
  })

  test('switches unit at each boundary', () => {
    expect(formatDurationMs(59_999)).toBe('60 s')
    expect(formatDurationMs(3_599_999)).toBe('60 min')
    expect(formatDurationMs(3_600_000)).toBe('1 h')
    expect(formatDurationMs(7_200_000)).toBe('2 h')
  })

  test('shows one decimal for values between units', () => {
    expect(formatDurationMs(1500)).toBe('1.5 s')
    expect(formatDurationMs(90_000)).toBe('1.5 min')
  })

  test('names zero rather than printing "0 ms"', () => {
    expect(formatDurationMs(0)).toBe('no delay')
  })

  test('returns nothing when there is no value to read', () => {
    expect(formatDurationMs(null)).toBe('')
    expect(formatDurationMs(undefined)).toBe('')
    expect(formatDurationMs(Number.NaN)).toBe('')
  })
})

describe('formatRate', () => {
  test('appends /s to the byte formatting', () => {
    expect(formatRate(0)).toBe('0 B/s')
    expect(formatRate(1536)).toBe('1.5 KB/s')
    expect(formatRate(20 * 1024 * 1024)).toBe('20.0 MB/s')
    expect(formatRate(null)).toBe('—')
  })
})

describe('formatEta', () => {
  test('reads seconds, minutes and hours', () => {
    expect(formatEta(45)).toBe('45s')
    expect(formatEta(750)).toBe('12m 30s')
    expect(formatEta(7500)).toBe('2h 05m')
  })

  test('shows a dash when the time left is unknown', () => {
    expect(formatEta(null)).toBe('—')
    expect(formatEta(-1)).toBe('—')
  })
})

// Local times, so the expectations hold in any time zone the tests run in.
const at = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

describe('formatClockTime', () => {
  test('reads a time as 24-hour HH:MM', () => {
    expect(formatClockTime(iso(at(2026, 10, 18, 14, 32)))).toBe('14:32')
    expect(formatClockTime(iso(at(2026, 10, 18, 9, 5)))).toBe('09:05')
  })

  test('is empty without a valid time', () => {
    expect(formatClockTime(null)).toBe('')
    expect(formatClockTime('not a date')).toBe('')
  })
})

describe('formatClockOrDay', () => {
  const now = at(2026, 10, 18, 16, 0)

  test('shows the time for today and the day otherwise', () => {
    expect(formatClockOrDay(iso(at(2026, 10, 18, 14, 2)), now)).toBe('14:02')
    expect(formatClockOrDay(iso(at(2026, 10, 17, 23, 50)), now)).toBe('17 Oct')
    expect(formatClockOrDay(iso(at(2025, 12, 30, 8, 0)), now)).toBe('30 Dec 2025')
  })
})

describe('formatCalendarDay', () => {
  const now = at(2026, 10, 18)

  test('reads a calendar day without shifting it by time zone', () => {
    expect(formatCalendarDay('2026-10-03', now)).toBe('3 Oct')
    expect(formatCalendarDay('2025-01-31', now)).toBe('31 Jan 2025')
  })

  test('is empty for anything that is not a day', () => {
    expect(formatCalendarDay(null, now)).toBe('')
    expect(formatCalendarDay('2026-10', now)).toBe('')
  })
})

describe('friendStatusWords', () => {
  const now = at(2026, 10, 18, 16, 0)
  const health = (overrides: Partial<Parameters<typeof friendStatusWords>[0]> = {}) =>
    ({ online: false, offlineSince: null, lastErrorCode: null, ...overrides })

  test('names an online friend and one not checked yet', () => {
    expect(friendStatusWords(health({ online: true }), now)).toEqual({ label: 'Online', tone: 'success' })
    expect(friendStatusWords(health({ online: null }), now)).toEqual({ label: 'Checking…', tone: 'neutral' })
  })

  test('names the reason a check failed when it is the friend\'s answer', () => {
    expect(friendStatusWords(health({ lastErrorCode: 'unauthorized' }), now).label).toBe('Rejected your key')
    expect(friendStatusWords(health({ lastErrorCode: 'forbidden' }), now).label).toBe('Is blocking you')
    expect(friendStatusWords(health({ lastErrorCode: 'incompatible' }), now)).toEqual({ label: 'Needs a newer jack', tone: 'warning' })
  })

  test('says since when a friend is offline', () => {
    expect(friendStatusWords(health({ lastErrorCode: 'timeout', offlineSince: iso(at(2026, 10, 18, 14, 2)) }), now))
      .toEqual({ label: 'Offline since 14:02', tone: 'error' })
    expect(friendStatusWords(health({ offlineSince: iso(at(2026, 10, 16, 14, 2)) }), now).label).toBe('Offline since 16 Oct')
    expect(friendStatusWords(health(), now).label).toBe('Offline')
  })
})
