import type { LogRecord } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { LogTail } from './logTail'

const line = (time: number, message = `line ${time}`): LogRecord => ({ time, level: 30, message })

describe('LogTail', () => {
  test('takes a whole first backfill', () => {
    const tail = new LogTail()
    const backfill = [line(1), line(2), line(3)]
    expect(tail.takeBackfill(backfill)).toEqual(backfill)
  })

  test('takes a line once, whichever way it comes', () => {
    const tail = new LogTail()
    expect(tail.take(line(1))).toBe(true)
    // The same line parsed again (from the file, or a second delivery).
    expect(tail.take({ ...line(1) })).toBe(false)
    expect(tail.take(line(1, 'another line in the same millisecond'))).toBe(true)
  })

  test('a backfill after a reconnect adds only the missed lines', () => {
    const tail = new LogTail()
    tail.takeBackfill([line(1), line(2)])
    tail.take(line(3))
    // jack restarted: 4 and 5 were logged while the stream was down.
    expect(tail.takeBackfill([line(1), line(2), line(3), line(4), line(5)])).toEqual([line(4), line(5)])
  })

  test('drops lines already taken from the stream while the backfill was on its way', () => {
    const tail = new LogTail()
    tail.takeBackfill([line(1)])
    expect(tail.takeBackfill([line(1), line(2), line(3)])).toEqual([line(2), line(3)])
    // The stream delivers 3 again after the backfill already added it.
    expect(tail.take(line(3))).toBe(false)
    expect(tail.take(line(4))).toBe(true)
  })

  test('leaves out backfilled lines older than the newest one taken', () => {
    const tail = new LogTail(2)
    tail.takeBackfill([line(1), line(2), line(3)])
    // 1 is no longer remembered, but it is older than 3, so it stays out (it was
    // shown, or cleared from view).
    expect(tail.takeBackfill([line(1), line(2), line(3), line(4)])).toEqual([line(4)])
  })

  test('reset forgets everything, for a new level filter', () => {
    const tail = new LogTail()
    tail.takeBackfill([line(1), line(2)])
    tail.reset()
    expect(tail.takeBackfill([line(1), line(2)])).toEqual([line(1), line(2)])
  })
})

describe('LogTail.missesLines', () => {
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i))

  test('is false before anything was taken', () => {
    expect(new LogTail().missesLines(lines(1, 500), 500)).toBe(false)
  })

  test('is false when the backfill reaches back to what was shown', () => {
    const tail = new LogTail()
    tail.takeBackfill(lines(0, 9))
    expect(tail.missesLines(lines(9, 508), 500)).toBe(false)
  })

  test('is false when the backfill was not full: it holds all there is', () => {
    const tail = new LogTail()
    tail.takeBackfill(lines(0, 9))
    expect(tail.missesLines(lines(20, 30), 500)).toBe(false)
  })

  test('is true when a full backfill starts after the newest line shown', () => {
    // 10 lines shown, then 1200 logged during a pause: the last 500 start at 710.
    const tail = new LogTail()
    tail.takeBackfill(lines(0, 9))
    expect(tail.missesLines(lines(710, 1209), 500)).toBe(true)
    // Fetching more fills the hole.
    expect(tail.missesLines(lines(9, 1209), 1201)).toBe(false)
  })
})

describe('LogTail.backfill', () => {
  // jack's log: lines 0 to `last`. Records how many lines each call asked for.
  function jackLog(last: number) {
    const asked: number[] = []
    const fetchLogs = async (n: number) => {
      asked.push(n)
      return Array.from({ length: last + 1 }, (_, i) => line(i)).slice(-n)
    }
    return { asked, fetchLogs }
  }

  test('a first load asks once and has no gap', async () => {
    const { asked, fetchLogs } = jackLog(1209)
    const result = await new LogTail().backfill(fetchLogs, { lines: 500, maxLines: 1500 })
    expect(asked).toEqual([500])
    expect(result!.records).toHaveLength(500)
    expect(result!.gap).toBe(false)
  })

  test('asks for more when the last lines leave a hole, and fills it', async () => {
    const tail = new LogTail()
    tail.takeBackfill([line(0), line(1), line(2), line(3), line(4), line(5), line(6), line(7), line(8), line(9)])
    // 1200 lines logged while the list was paused.
    const { asked, fetchLogs } = jackLog(1209)
    const result = await tail.backfill(fetchLogs, { lines: 500, maxLines: 1500 })
    expect(asked).toEqual([500, 1500])
    expect(result!.gap).toBe(false)
    expect(result!.records[0]).toEqual(line(10))
    expect(result!.records).toHaveLength(1200)
  })

  test('marks the hole that even the most it asks for leaves', async () => {
    const tail = new LogTail()
    tail.takeBackfill([line(0)])
    const { asked, fetchLogs } = jackLog(5000)
    const result = await tail.backfill(fetchLogs, { lines: 500, maxLines: 1500 })
    expect(asked).toEqual([500, 1500])
    expect(result!.gap).toBe(true)
    expect(result!.records[0]).toEqual(line(3501))
  })

  test('takes nothing when the answer is no longer wanted', async () => {
    const tail = new LogTail()
    const { fetchLogs } = jackLog(10)
    expect(await tail.backfill(fetchLogs, { lines: 500, maxLines: 1500, wanted: () => false })).toBeUndefined()
    expect(tail.take(line(10))).toBe(true)
  })
})
