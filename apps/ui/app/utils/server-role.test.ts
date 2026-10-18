import type { DestinationRegistration } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { ARR_CONTACT_GRACE_MS, arrContact, arrName, formatTimeAgo, registersJack, registrationFix, registrationStepDetail, registrationSummary, serverRoleLabel } from './server-role'

function registration(overrides: Partial<DestinationRegistration> = {}): DestinationRegistration {
  return {
    at: '2026-10-18T10:00:00.000Z',
    indexer: { status: 'ok' },
    downloadClient: { status: 'ok' },
    clientTest: 'ok',
    indexerTest: 'ok',
    message: null,
    testErrors: { downloadClient: null, indexer: null },
    ...overrides,
  }
}

const AT = Date.parse('2026-10-18T10:00:00.000Z')

describe('serverRoleLabel', () => {
  test('names each role in words', () => {
    expect(serverRoleLabel({ source: true, destination: false })).toBe('shares with friends')
    expect(serverRoleLabel({ source: false, destination: true })).toBe('receives downloads')
    expect(serverRoleLabel({ source: true, destination: true })).toBe('shares with friends · receives downloads')
  })

  test('says when a server does nothing', () => {
    expect(serverRoleLabel({ source: false, destination: false })).toBe('not in use')
  })
})

describe('arrName', () => {
  test('capitalizes the server type', () => {
    expect(arrName('radarr')).toBe('Radarr')
    expect(arrName('sonarr')).toBe('Sonarr')
  })
})

describe('registersJack', () => {
  test('only for a destination with auto-register on', () => {
    expect(registersJack({ destination: true, autoregister: { enable: true } })).toBe(true)
    expect(registersJack({ destination: true, autoregister: { enable: false } })).toBe(false)
    expect(registersJack({ destination: false, autoregister: { enable: true } })).toBe(false)
  })
})

describe('registrationSummary', () => {
  test('ticks both steps when they were added and passed their tests', () => {
    expect(registrationSummary(registration())).toEqual({
      parts: [{ text: 'indexer ✓', tone: 'ok' }, { text: 'download client ✓', tone: 'ok' }],
      tone: 'ok',
    })
  })

  test('says once that downloads are off', () => {
    const skipped = { status: 'skipped', reason: 'downloads-off' } as const
    expect(registrationSummary(registration({ reason: 'downloads-off', indexer: skipped, downloadClient: skipped, clientTest: 'skipped', indexerTest: 'skipped', message: 'Downloads are off…' }))).toEqual({
      parts: [{ text: 'skipped (downloads off)', tone: 'warning' }],
      tone: 'warning',
    })
  })

  test('a failed test fails its step', () => {
    const summary = registrationSummary(registration({ clientTest: 'failed', message: 'Radarr can\'t resolve jack.' }))
    expect(summary.parts.map(p => p.text)).toEqual(['indexer ✓', 'download client failed'])
    expect(summary.tone).toBe('error')
  })

  test('a failed step and the indexer it skipped', () => {
    const summary = registrationSummary(registration({
      downloadClient: { status: 'failed', error: 'boom' },
      indexer: { status: 'skipped', reason: 'client-failed' },
      clientTest: 'skipped',
      indexerTest: 'skipped',
    }))
    expect(summary.parts).toEqual([{ text: 'indexer skipped', tone: 'warning' }, { text: 'download client failed', tone: 'error' }])
    expect(summary.tone).toBe('error')
  })

  test('a download client added but not tested waits for a restart', () => {
    const summary = registrationSummary(registration({ clientTest: 'skipped', message: 'Restart the jack container so Radarr can use jack\'s download client.' }))
    expect(summary.parts).toEqual([{ text: 'indexer ✓', tone: 'ok' }, { text: 'download client waits for a restart', tone: 'warning' }])
    expect(summary.tone).toBe('warning')
  })

  test('a message without a failure is a warning', () => {
    const summary = registrationSummary(registration({ message: 'A note from jack.' }))
    expect(summary.parts.map(p => p.text)).toEqual(['indexer ✓', 'download client ✓'])
    expect(summary.tone).toBe('warning')
  })
})

describe('registrationStepDetail', () => {
  test('describes what jack did and what the *arr\'s test said', () => {
    expect(registrationStepDetail({ status: 'ok' }, 'ok', 'Radarr')).toBe('Added. Radarr\'s test passed.')
    expect(registrationStepDetail({ status: 'ok' }, 'failed', 'Radarr')).toBe('Added, but Radarr\'s test failed.')
    expect(registrationStepDetail({ status: 'ok' }, 'skipped', 'Radarr')).toBe('Added. Works after you restart the jack container.')
    expect(registrationStepDetail({ status: 'failed', error: 'HTTP 400' }, 'skipped', 'Radarr')).toBe('jack couldn\'t add it: HTTP 400')
    expect(registrationStepDetail({ status: 'skipped', reason: 'downloads-off' }, 'skipped', 'Radarr')).toBe('Skipped, because downloads are off.')
    expect(registrationStepDetail({ status: 'skipped', reason: 'client-failed' }, 'skipped', 'Radarr')).toBe('Skipped, because the download client failed.')
  })
})

describe('registrationFix', () => {
  test('points at the setting the message names', () => {
    expect(registrationFix(registration({ reason: 'downloads-off' }))).toEqual({ section: 'downloads', label: 'Turn on downloads' })
    expect(registrationFix(registration({ clientTest: 'failed', message: 'Radarr can\'t resolve jack. Use your server\'s IP in Address Radarr/Sonarr use to reach jack.' }))).toEqual({ section: 'internal-url', label: 'Change the address' })
    expect(registrationFix(registration({ indexerTest: 'failed', message: 'Radarr reached jack, but the indexer test took longer than 45 seconds.' }))).toBeNull()
    expect(registrationFix(registration())).toBeNull()
  })
})

describe('arrContact', () => {
  test('reports the last contact when there is one', () => {
    expect(arrContact({ registration: null, lastContactAt: '2026-10-18T10:05:00.000Z' }, AT)).toEqual({ state: 'reached', at: '2026-10-18T10:05:00.000Z' })
  })

  test('says "never" only once the grace period after registering has passed', () => {
    const server = { registration: registration(), lastContactAt: null }
    expect(arrContact(server, AT + ARR_CONTACT_GRACE_MS - 1)).toEqual({ state: 'waiting' })
    expect(arrContact(server, AT + ARR_CONTACT_GRACE_MS)).toEqual({ state: 'never' })
  })

  test('has nothing to say when jack added nothing', () => {
    const skipped = { status: 'skipped', reason: 'downloads-off' } as const
    expect(arrContact({ registration: null, lastContactAt: null }, AT)).toEqual({ state: 'unknown' })
    expect(arrContact({ registration: registration({ indexer: skipped, downloadClient: skipped }), lastContactAt: null }, AT + ARR_CONTACT_GRACE_MS)).toEqual({ state: 'unknown' })
  })
})

describe('formatTimeAgo', () => {
  test('counts minutes, hours and days', () => {
    const iso = '2026-10-18T10:00:00.000Z'
    expect(formatTimeAgo(iso, AT + 30_000)).toBe('just now')
    expect(formatTimeAgo(iso, AT + 3 * 60_000)).toBe('3 min ago')
    expect(formatTimeAgo(iso, AT + 2 * 3_600_000)).toBe('2 h ago')
    expect(formatTimeAgo(iso, AT + 24 * 3_600_000)).toBe('1 day ago')
    expect(formatTimeAgo(iso, AT + 72 * 3_600_000)).toBe('3 days ago')
  })

  test('treats a time ahead of the clock as just now', () => {
    expect(formatTimeAgo('2026-10-18T10:01:00.000Z', AT)).toBe('just now')
  })
})
