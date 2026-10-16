import type { BandwidthConfig } from '../lib/config'
import { describe, expect, test } from 'bun:test'
import { RateLimiter } from '../lib/bandwidth/rate-limiter'
import { periodCovers, resolveBandwidthLimits } from '../lib/bandwidth/schedule'
import { BandwidthConfig as BandwidthConfigSchema } from '../lib/config'

function fakeClock() {
  let now = 0
  const sleeps: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
    advance: (ms: number) => {
      now += ms
    },
    sleeps,
  }
}

describe('RateLimiter', () => {
  test('does not wait when unlimited', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter(null, clock.now, clock.sleep)
    await limiter.take(100 * 1024 * 1024)
    expect(clock.sleeps).toEqual([])
  })

  test('paces a stream of chunks to the configured rate', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter(1000, clock.now, clock.sleep)
    for (let i = 0; i < 10; i++)
      await limiter.take(500)
    // 5000 bytes at 1000 B/s take 5s; the 250ms burst allowance is the only slack.
    expect(clock.now()).toBe(4750)
  })

  test('concurrent callers share one rate', async () => {
    // All three arrive at t=0; the clock stands still while they're scheduled.
    const sleeps: number[] = []
    const limiter = new RateLimiter(1000, () => 0, async (ms) => {
      sleeps.push(ms)
    })
    await Promise.all([limiter.take(1000), limiter.take(1000), limiter.take(1000)])
    expect(sleeps).toEqual([750, 1750, 2750])
  })

  test('an idle period does not bank credit for a later burst', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter(1000, clock.now, clock.sleep)
    await limiter.take(1000)
    clock.advance(60_000)
    await limiter.take(2000)
    expect(clock.sleeps.at(-1)).toBe(1750)
  })

  test('changing the rate drops the backlog scheduled at the old rate', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter(1, clock.now, clock.sleep)
    await limiter.take(1000)
    limiter.setRate(null)
    const before = clock.sleeps.length
    await limiter.take(1_000_000)
    expect(clock.sleeps.length).toBe(before)
  })

  test('aborting a wait rejects with the signal reason', async () => {
    const limiter = new RateLimiter(1)
    const controller = new AbortController()
    const pending = limiter.take(10_000, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })
})

// 2026-10-16 is a Friday.
function at(day: number, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number)
  return new Date(2026, 9, day, hours, minutes)
}

describe('bandwidth schedule', () => {
  const weekdays = { days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const, start: '07:00', end: '23:00' }

  test('a daytime period covers start inclusive and end exclusive', () => {
    const period = { ...weekdays, days: [...weekdays.days] }
    expect(periodCovers(period, at(16, '07:00'))).toBe(true)
    expect(periodCovers(period, at(16, '22:59'))).toBe(true)
    expect(periodCovers(period, at(16, '23:00'))).toBe(false)
    expect(periodCovers(period, at(17, '12:00'))).toBe(false) // Saturday
  })

  test('an overnight period belongs to the day it starts on', () => {
    const period = { days: ['fri' as const], start: '23:00', end: '07:00' }
    expect(periodCovers(period, at(16, '23:30'))).toBe(true) // Friday night
    expect(periodCovers(period, at(17, '06:59'))).toBe(true) // Saturday morning
    expect(periodCovers(period, at(17, '07:00'))).toBe(false)
    expect(periodCovers(period, at(16, '06:00'))).toBe(false) // Friday morning came from Thursday
  })

  test('start equal to end covers the whole day', () => {
    expect(periodCovers({ days: ['sat'], start: '00:00', end: '00:00' }, at(17, '13:37'))).toBe(true)
  })

  test('the first matching period wins and unset limits fall back to the defaults', () => {
    const config: BandwidthConfig = BandwidthConfigSchema.parse({
      downloadLimitKiBps: 1000,
      uploadLimitKiBps: 500,
      schedule: [
        { days: ['fri'], start: '07:00', end: '23:00', downloadLimitKiBps: 100 },
        { days: ['fri'], start: '00:00', end: '00:00', downloadLimitKiBps: 1, uploadLimitKiBps: 1 },
      ],
    })
    expect(resolveBandwidthLimits(config, at(16, '12:00'))).toEqual({
      downloadBytesPerSecond: 100 * 1024,
      uploadBytesPerSecond: 500 * 1024,
      periodIndex: 0,
    })
    expect(resolveBandwidthLimits(config, at(16, '23:30')).periodIndex).toBe(1)
  })

  test('outside every period the defaults apply, and no config means unlimited', () => {
    const config = BandwidthConfigSchema.parse({ uploadLimitKiBps: 64, schedule: [{ ...weekdays, days: ['mon'], downloadLimitKiBps: 1 }] })
    expect(resolveBandwidthLimits(config, at(16, '12:00'))).toEqual({ downloadBytesPerSecond: null, uploadBytesPerSecond: 64 * 1024, periodIndex: null })
    expect(resolveBandwidthLimits(undefined, at(16, '12:00'))).toEqual({ downloadBytesPerSecond: null, uploadBytesPerSecond: null, periodIndex: null })
  })

  test('the schema rejects malformed times and empty day lists', () => {
    expect(() => BandwidthConfigSchema.parse({ schedule: [{ days: ['mon'], start: '7:00', end: '23:00' }] })).toThrow()
    expect(() => BandwidthConfigSchema.parse({ schedule: [{ days: ['mon'], start: '24:00', end: '23:00' }] })).toThrow()
    expect(() => BandwidthConfigSchema.parse({ schedule: [{ days: [], start: '07:00', end: '23:00' }] })).toThrow()
  })
})
