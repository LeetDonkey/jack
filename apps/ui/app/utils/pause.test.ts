import type { PauseState } from '~/types/tools'
import { describe, expect, test } from 'bun:test'
import { isPauseActive, nextMorning, pauseChoiceLabel, pauseStateText, pauseTimeText, pauseUntil } from './pause'

// Local times, so the tests pass in any time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)

const NOT_PAUSED: PauseState = { paused: false, until: null, indefinite: false }
const INDEFINITE: PauseState = { paused: true, until: null, indefinite: true }
const until = (date: Date): PauseState => ({ paused: true, until: date.toISOString(), indefinite: false })

describe('nextMorning', () => {
  test('is tomorrow 08:00 during the day', () => {
    expect(nextMorning(at(18, 14))).toEqual(at(19, 8))
  })

  test('is this morning after midnight', () => {
    expect(nextMorning(at(18, 1, 30))).toEqual(at(18, 8))
  })

  test('skips to tomorrow when 08:00 is less than an hour away', () => {
    expect(nextMorning(at(18, 7, 30))).toEqual(at(19, 8))
    expect(nextMorning(at(18, 7))).toEqual(at(18, 8))
  })

  test('crosses the end of a month', () => {
    expect(nextMorning(at(31, 22))).toEqual(new Date(2026, 10, 1, 8))
  })
})

describe('pauseUntil', () => {
  const now = at(18, 14)

  test('adds an hour or four', () => {
    expect(pauseUntil('1h', now)).toBe(at(18, 15).toISOString())
    expect(pauseUntil('4h', now)).toBe(at(18, 18).toISOString())
  })

  test('pauses until the next morning', () => {
    expect(pauseUntil('morning', now)).toBe(at(19, 8).toISOString())
  })

  test('sends indefinite as the API spells it', () => {
    expect(pauseUntil('indefinite', now)).toBe('indefinite')
  })
})

describe('pauseTimeText', () => {
  const now = at(18, 14)

  test('says the time today, tomorrow, within the week and later', () => {
    expect(pauseTimeText(at(18, 18, 30), now)).toBe('18:30')
    expect(pauseTimeText(at(19, 8), now)).toBe('tomorrow 08:00')
    expect(pauseTimeText(at(20, 9, 5), now)).toBe('Tue 09:05')
    expect(pauseTimeText(at(25, 8), now)).toBe('25 Oct, 08:00')
  })
})

describe('pauseChoiceLabel', () => {
  test('names the morning it would resume', () => {
    expect(pauseChoiceLabel('morning', at(18, 14))).toBe('Until tomorrow 08:00')
    expect(pauseChoiceLabel('morning', at(18, 2))).toBe('Until 08:00')
  })

  test('labels the fixed choices', () => {
    expect(pauseChoiceLabel('1h', at(18, 14))).toBe('For 1 hour')
    expect(pauseChoiceLabel('4h', at(18, 14))).toBe('For 4 hours')
    expect(pauseChoiceLabel('indefinite', at(18, 14))).toBe('Until I resume')
  })
})

describe('isPauseActive', () => {
  const now = at(18, 14)

  test('is off when not paused or unknown', () => {
    expect(isPauseActive(NOT_PAUSED, now)).toBe(false)
    expect(isPauseActive(null, now)).toBe(false)
    expect(isPauseActive(undefined, now)).toBe(false)
  })

  test('holds until its time, then ends on its own', () => {
    expect(isPauseActive(until(at(18, 15)), now)).toBe(true)
    expect(isPauseActive(until(at(18, 13)), now)).toBe(false)
  })

  test('an indefinite pause stays on', () => {
    expect(isPauseActive(INDEFINITE, now)).toBe(true)
  })
})

describe('pauseStateText', () => {
  const now = at(18, 14)

  test('names what is paused and until when', () => {
    expect(pauseStateText('uploads', until(at(18, 18, 30)), now)).toBe('Sharing paused until 18:30')
    expect(pauseStateText('downloads', until(at(19, 8)), now)).toBe('Downloads paused until tomorrow 08:00')
  })

  test('an indefinite pause waits for you', () => {
    expect(pauseStateText('uploads', INDEFINITE, now)).toBe('Sharing paused until you resume')
  })

  test('says nothing when not paused or the time has passed', () => {
    expect(pauseStateText('uploads', NOT_PAUSED, now)).toBeNull()
    expect(pauseStateText('uploads', until(at(18, 13)), now)).toBeNull()
  })
})
