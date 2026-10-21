import { describe, expect, test } from 'bun:test'
import { bandwidthFormField, kibFromMb, kibToSave, limitError, mbFromKib } from './bandwidth-limits'

describe('kibFromMb', () => {
  test('keeps empty as empty (unlimited)', () => {
    expect(kibFromMb(null)).toBeNull()
    expect(kibFromMb(undefined)).toBeNull()
  })

  test('converts MB/s to KiB/s, at least 1', () => {
    expect(kibFromMb(4)).toBe(4096)
    expect(kibFromMb(0.5)).toBe(512)
    expect(kibFromMb(0.2)).toBe(205)
    expect(kibFromMb(0.0001)).toBe(1)
  })

  test('never turns 0 into unlimited', () => {
    expect(kibFromMb(0)).toBe(1)
  })
})

describe('mbFromKib', () => {
  test('rounds to three decimals and keeps empty', () => {
    expect(mbFromKib(4096)).toBe(4)
    expect(mbFromKib(205)).toBe(0.2)
    expect(mbFromKib(64)).toBe(0.063)
    expect(mbFromKib(null)).toBeNull()
    expect(mbFromKib(undefined)).toBeNull()
  })

  test('shows the smallest limits instead of 0', () => {
    expect(mbFromKib(1)).toBe(0.001)
    expect(mbFromKib(5)).toBe(0.005)
  })

  test('no stored limit comes back as a value the form refuses', () => {
    for (let kib = 1; kib <= 20_000; kib++) {
      expect(limitError(mbFromKib(kib), 'upload')).toBeNull()
      expect(limitError(mbFromKib(kib), 'download', true)).toBeNull()
    }
  })

  // The number input keeps 3 decimals, so these are all the values it can hold.
  test('a typed limit shows the same after saving and loading it again', () => {
    for (let n = 1; n <= 20_000; n++) {
      const typed = n / 1000
      expect(mbFromKib(kibFromMb(typed))).toBe(typed)
    }
  })
})

describe('kibToSave', () => {
  test('keeps a stored limit the field still shows', () => {
    expect(kibFromMb(mbFromKib(64))).toBe(65)
    expect(kibToSave(mbFromKib(64), 64)).toBe(64)
    for (let kib = 1; kib <= 20_000; kib++)
      expect(kibToSave(mbFromKib(kib), kib)).toBe(kib)
  })

  test('converts a changed or new value, and keeps empty as empty', () => {
    expect(kibToSave(0.5, 64)).toBe(512)
    expect(kibToSave(0.001, null)).toBe(1)
    expect(kibToSave(2, undefined)).toBe(2048)
    expect(kibToSave(null, 64)).toBeNull()
  })
})

describe('limitError', () => {
  test('accepts empty and positive limits', () => {
    expect(limitError(null, 'upload')).toBeNull()
    expect(limitError(0.1, 'download', true)).toBeNull()
    expect(limitError(0.001, 'upload')).toBeNull()
  })

  test('refuses 0 and below on the limits for all friends', () => {
    expect(limitError(0, 'upload')).toBe('Must be more than 0. Empty means no limit. To stop uploads, use Pause sharing.')
    expect(limitError(-1, 'download')).toBe('Must be more than 0. Empty means no limit. To stop downloads, use Pause downloads.')
  })

  test('refuses 0 in a schedule period', () => {
    expect(limitError(0, 'upload', true)).toBe('Must be more than 0. Empty uses the limit above. To stop uploads, use Pause sharing.')
    expect(limitError(0, 'download', true)).toBe('Must be more than 0. Empty uses the limit above. To stop downloads, use Pause downloads.')
  })
})

describe('bandwidthFormField', () => {
  test('names the MB/s field for a limit jack holds in KiB/s', () => {
    expect(bandwidthFormField('uploadLimitKiBps')).toBe('uploadMb')
    expect(bandwidthFormField('downloadLimitKiBps')).toBe('downloadMb')
    expect(bandwidthFormField('maxConcurrentUploads')).toBe('maxConcurrentUploads')
  })

  test('puts a period\'s start and end on its time field, and a bad day on its days', () => {
    expect(bandwidthFormField('schedule.2.start')).toBe('schedule.2.time')
    expect(bandwidthFormField('schedule.0.end')).toBe('schedule.0.time')
    expect(bandwidthFormField('schedule.1.days.3')).toBe('schedule.1.days')
    expect(bandwidthFormField('schedule.1.uploadLimitKiBps')).toBe('schedule.1.uploadMb')
  })

  test('is null for a field the form doesn\'t have', () => {
    expect(bandwidthFormField('pausedUntil')).toBeNull()
    expect(bandwidthFormField('schedule')).toBeNull()
    expect(bandwidthFormField('schedule.0.colour')).toBeNull()
  })
})
