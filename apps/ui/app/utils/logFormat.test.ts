import { describe, expect, test } from 'bun:test'
import { docsUrl } from './docs'
import { clockTime, logDateTime, logDayBreaks, logDayLabel, logHelp, logIsoTime, logRuns, logSegmentBreaks } from './logFormat'
import { settingsLink } from './settings-links'

const troubleshooting = docsUrl('unraid', 'troubleshooting')

describe('logHelp', () => {
  // Messages as jack logs them; the destination names are examples.
  test.each([
    'Downloads are off, so jack did not add its indexer or download client to Radarr/Sonarr. Turn on Downloads in Settings, then restart the jack container.',
    'Turned off the Jack indexer in Radarr: it has no download client, and downloads are off',
    'Failed to register download client',
    'Failed to register indexer',
    'Registration failed',
    'Radarr can\'t use jack: Radarr can\'t resolve jack.',
  ])('links "%s" to the troubleshooting guide', (message) => {
    expect(logHelp({ message })).toEqual({ label: 'Troubleshooting guide', to: troubleshooting, external: true })
  })

  test('links a refused *arr address to the Security settings', () => {
    const message = 'Refused the Radarr/Sonarr API to an address outside your LAN. If it is your own Radarr or Sonarr, add it under Settings -> Sharing -> Security -> Also allow.'
    expect(logHelp({ message })).toEqual({ label: 'Open Security settings', to: settingsLink('security'), external: false })
  })

  test('leaves other lines alone', () => {
    expect(logHelp({ message: 'Registered Jack as qBittorrent download client' })).toBeNull()
    expect(logHelp({ message: 'Radarr tested its connection to jack' })).toBeNull()
    expect(logHelp({ message: 'Server listening' })).toBeNull()
    expect(logHelp({})).toBeNull()
  })
})

// Local times, so the tests hold in any time zone.
const at = (month: number, day: number, h = 0, m = 0, s = 0, ms = 0, year = 2026) => new Date(year, month - 1, day, h, m, s, ms).getTime()
const NOW = at(10, 19, 9, 30)

describe('clockTime', () => {
  test('shows the time of day with milliseconds', () => {
    expect(clockTime(at(10, 17, 21, 5, 39, 7))).toBe('21:05:39.007')
  })

  test('is empty without a valid time', () => {
    expect(clockTime(undefined)).toBe('')
    expect(clockTime('21:05')).toBe('')
    expect(clockTime(Number.NaN)).toBe('')
  })
})

describe('logDateTime', () => {
  test('gives the full date and time', () => {
    expect(logDateTime(at(10, 17, 21, 5, 39, 123))).toBe('Sat 17 Oct 2026, 21:05:39.123')
  })

  test('is empty without a valid time', () => {
    expect(logDateTime(undefined)).toBe('')
  })
})

describe('logIsoTime', () => {
  test('gives ISO 8601 for <time datetime>', () => {
    expect(logIsoTime(Date.UTC(2026, 9, 17, 19, 5, 39, 123))).toBe('2026-10-17T19:05:39.123Z')
    expect(logIsoTime(undefined)).toBeUndefined()
  })
})

describe('logDayLabel', () => {
  test('names today and yesterday', () => {
    expect(logDayLabel(at(10, 19, 0, 0), NOW)).toBe('Today')
    expect(logDayLabel(at(10, 18, 23, 59), NOW)).toBe('Yesterday')
  })

  test('gives older days their date, with the year when it differs', () => {
    expect(logDayLabel(at(10, 17, 21, 5), NOW)).toBe('Sat 17 Oct')
    expect(logDayLabel(at(12, 31, 12, 0, 0, 0, 2025), NOW)).toBe('Wed 31 Dec 2025')
  })

  test('counts yesterday across a month boundary', () => {
    expect(logDayLabel(at(9, 30, 22), at(10, 1, 8))).toBe('Yesterday')
  })
})

describe('logDayBreaks', () => {
  test('adds nothing when every line is from today', () => {
    expect(logDayBreaks([{ time: at(10, 19, 4, 43) }, { time: at(10, 19, 5, 2) }], NOW)).toEqual(['', ''])
  })

  test('marks where each day starts once the list reaches back', () => {
    // Bob's log after the upgrade: 17 Oct, 18 Oct, then this morning.
    const rows = [
      { time: at(10, 17, 21, 5, 39) },
      { time: at(10, 17, 22, 0, 17) },
      { time: at(10, 18, 14, 0, 19) },
      { time: at(10, 19, 4, 43, 33) },
      { time: at(10, 19, 5, 2, 20) },
    ]
    expect(logDayBreaks(rows, NOW)).toEqual(['Sat 17 Oct', '', 'Yesterday', 'Today', ''])
  })

  test('skips lines without a time', () => {
    expect(logDayBreaks([{ time: at(10, 18, 23) }, {}, { time: at(10, 18, 23, 30) }], NOW)).toEqual(['Yesterday', '', ''])
  })
})

describe('logRuns', () => {
  // A line as jack logs it, `ms` after 22:13 on 18 Oct.
  const log = (ms: number, message: string, hostname = 'c0ffee') => ({ time: at(10, 18, 22, 13) + ms, message, hostname })

  test('keeps a list without a start in run 0', () => {
    expect(logRuns([log(0, 'Registered Jack as qBittorrent download client'), log(10, 'Radarr tested its connection to jack')])).toEqual([0, 0])
  })

  test('starts a run after a shutdown, at the first line jack logged while starting', () => {
    // From ux/shots/b4-fresh/logs.png: a docker restart, then a new start on the same day.
    const rows = [
      log(0, 'Server listening'),
      log(5, 'Management API listening'),
      log(60_000, 'Registered Jack as qBittorrent download client'),
      log(600_000, 'SIGTERM received, exiting'),
      // The old jack still finishing up before it exits.
      log(600_200, 'Download failed'),
      log(601_000, 'Initializing connector Radarr'),
      log(601_027, 'Server listening'),
      log(601_031, 'Management API listening'),
      log(601_090, 'Registered Jack as qBittorrent download client'),
    ]
    expect(logRuns(rows)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2])
  })

  test('marks the first start the list holds, from its first line', () => {
    const rows = [
      log(0, 'Config file not found at /config/config.jsonc. Creating default config file...'),
      log(4, 'Wrote the default config'),
      log(169, 'Server listening'),
      log(174, 'Management API listening'),
    ]
    expect(logRuns(rows)).toEqual([1, 1, 1, 1])
  })

  test('counts the wait for Radarr and Sonarr as part of the start', () => {
    const rows = [
      log(0, 'Radarr tested its connection to jack'),
      log(5_000, 'Initializing connector Radarr'),
      log(5_001, 'Initializing connector Sonarr'),
      // Radarr doesn't answer until its timeout.
      log(15_001, 'Failed to initialize connector Radarr: The operation timed out.'),
      log(25_000, 'Server listening'),
    ]
    expect(logRuns(rows)).toEqual([0, 1, 1, 1, 1])
  })

  test('starts a run after a crash at the gap before the start', () => {
    // No shutdown line: jack stopped without one and Docker started it again.
    const rows = [
      log(0, 'Download failed'),
      log(900, 'Server listening'),
      log(905, 'Management API listening'),
    ]
    expect(logRuns(rows)).toEqual([0, 1, 1])
  })

  test('starts a run where the container changes', () => {
    // An update recreates the container: jack's lines come from a new hostname.
    const rows = [
      log(0, 'Download failed', 'old'),
      log(300, 'Initializing connector Radarr', 'new'),
      log(330, 'Server listening', 'new'),
    ]
    expect(logRuns(rows)).toEqual([0, 1, 1])
  })

  test('tells back-to-back starts apart', () => {
    const rows = [
      log(0, 'Server listening'),
      log(4, 'Management API listening'),
      log(800, 'Server listening'),
      log(804, 'Management API listening'),
    ]
    expect(logRuns(rows)).toEqual([1, 1, 2, 2])
  })
})

describe('logSegmentBreaks', () => {
  test('breaks where the number changes, and above a first row past 0', () => {
    expect(logSegmentBreaks([0, 0, 1, 1, 2])).toEqual([false, false, true, false, true])
    expect(logSegmentBreaks([1, 1, 2])).toEqual([true, false, true])
    expect(logSegmentBreaks([])).toEqual([])
  })
})
