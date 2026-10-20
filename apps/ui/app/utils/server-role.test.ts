import type { DestinationRegistration } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { ARR_CONTACT_GRACE_MS, arrContact, arrMedia, arrName, formatPauseEnd, formatTimeAgo, indexerPause, indexerPausedUntil, indexerPauseText, registersJack, registrationFix, registrationHeadline, registrationStepDetail, registrationStepTone, registrationSummary, serverRoleLabel } from './server-role'

function registration(overrides: Partial<DestinationRegistration> = {}): DestinationRegistration {
  return {
    at: '2026-10-18T10:00:00.000Z',
    indexer: { status: 'ok' },
    downloadClient: { status: 'ok' },
    clientTest: 'ok',
    indexerTest: 'ok',
    message: null,
    testErrors: { downloadClient: null, indexer: null },
    indexerPausedUntil: null,
    indexerPaused: null,
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
    expect(registrationStepDetail('downloadClient', { status: 'ok' }, 'ok', 'Radarr')).toBe('Added. Radarr\'s test passed.')
    expect(registrationStepDetail('downloadClient', { status: 'ok' }, 'failed', 'Radarr')).toBe('Added, but Radarr\'s test failed.')
    expect(registrationStepDetail('downloadClient', { status: 'ok' }, 'skipped', 'Radarr')).toBe('Added. Works after you restart the jack container.')
    expect(registrationStepDetail('downloadClient', { status: 'failed', error: 'HTTP 400' }, 'skipped', 'Radarr')).toBe('jack couldn\'t add it: HTTP 400')
    expect(registrationStepDetail('downloadClient', { status: 'skipped', reason: 'downloads-off' }, 'skipped', 'Radarr')).toBe('Skipped, because downloads are off.')
    expect(registrationStepDetail('indexer', { status: 'skipped', reason: 'client-failed' }, 'skipped', 'Radarr')).toBe('Skipped, because the download client failed.')
  })

  test('an untested indexer doesn\'t wait for a restart', () => {
    expect(registrationStepDetail('indexer', { status: 'ok' }, 'skipped', 'Radarr')).toBe('Added. Radarr hasn\'t tested it yet.')
  })

  test('never says the test passed while the indexer is paused', () => {
    expect(registrationStepDetail('indexer', { status: 'ok' }, 'ok', 'Radarr', 'until 17:36')).toBe('Added, but Radarr is skipping it until 17:36.')
    expect(registrationStepDetail('indexer', { status: 'ok' }, 'failed', 'Radarr', 'until 17:36')).toBe('Added, but Radarr\'s test failed. Radarr is skipping it until 17:36.')
    expect(registrationStepDetail('indexer', { status: 'ok' }, 'ok', 'Radarr', 'for a while')).toBe('Added, but Radarr is skipping it for a while.')
    // The pause is the indexer's alone.
    expect(registrationStepDetail('downloadClient', { status: 'ok' }, 'ok', 'Radarr', 'until 17:36')).toBe('Added. Radarr\'s test passed.')
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

describe('arrMedia', () => {
  test('names what friends share with each kind', () => {
    expect(arrMedia('radarr')).toBe('movies')
    expect(arrMedia('sonarr')).toBe('episodes')
  })
})

// Local times, so the clock words don't depend on the time zone the tests run in.
const NOW = new Date(2026, 9, 19, 14, 0).getTime()
const LATER_TODAY = new Date(2026, 9, 19, 17, 36).toISOString()
const TOMORROW = new Date(2026, 9, 20, 3, 10).toISOString()
const RADARR = { name: 'Radarr', type: 'radarr' }

describe('indexerPausedUntil', () => {
  test('is the end of a pause still ahead', () => {
    expect(indexerPausedUntil(registration({ indexerPausedUntil: LATER_TODAY }), NOW)).toBe(LATER_TODAY)
  })

  test('is null without a pause, after it ended, or for a time jack can\'t read', () => {
    expect(indexerPausedUntil(null, NOW)).toBeNull()
    expect(indexerPausedUntil(registration(), NOW)).toBeNull()
    expect(indexerPausedUntil(registration({ indexerPausedUntil: LATER_TODAY }), Date.parse(LATER_TODAY))).toBeNull()
    expect(indexerPausedUntil(registration({ indexerPausedUntil: 'soon' }), NOW)).toBeNull()
  })
})

// Radarr and Sonarr only say that they skip the indexer, not until when.
describe('indexerPause', () => {
  test('has the end when the *arr gives one', () => {
    expect(indexerPause(registration({ indexerPausedUntil: LATER_TODAY }), NOW)).toEqual({ until: LATER_TODAY })
  })

  test('is a pause without an end when the *arr only says it pauses', () => {
    expect(indexerPause(registration({ indexerPaused: true }), NOW)).toEqual({ until: null })
  })

  test('is null when nothing says the indexer is paused', () => {
    expect(indexerPause(null, NOW)).toBeNull()
    expect(indexerPause(registration({ indexerPaused: false }), NOW)).toBeNull()
    expect(indexerPause(registration({ indexerPaused: null }), NOW)).toBeNull()
    expect(indexerPause(registration({ indexerPausedUntil: LATER_TODAY }), Date.parse(LATER_TODAY))).toBeNull()
  })
})

describe('formatPauseEnd', () => {
  test('gives the clock time today, and the day too otherwise', () => {
    expect(formatPauseEnd(LATER_TODAY, NOW)).toBe('17:36')
    expect(formatPauseEnd(TOMORROW, NOW)).toBe('03:10 on 20 Oct')
  })
})

describe('indexerPauseText', () => {
  test('says what is skipped until when, and that nothing needs doing', () => {
    expect(indexerPauseText(RADARR, registration({ indexerPausedUntil: LATER_TODAY }), NOW)).toEqual({
      title: 'Radarr is skipping jack\'s indexer until 17:36, so it won\'t find friends\' movies before then.',
      detail: 'Radarr pauses an indexer after errors and resumes it by itself at that time. You don\'t need to do anything.',
    })
    expect(indexerPauseText({ name: 'Sonarr 4K', type: 'sonarr' }, registration({ indexerPausedUntil: TOMORROW }), NOW)?.title)
      .toBe('Sonarr 4K is skipping jack\'s indexer until 03:10 on 20 Oct, so it won\'t find friends\' episodes before then.')
  })

  // Register again only helps when the *arr's test finds friends' releases of the
  // last 7 days, and jack runs that test by itself while the pause lasts.
  test('never sends the user to Register again', () => {
    const texts = [
      registration({ indexerPausedUntil: LATER_TODAY }),
      registration({ indexerPausedUntil: LATER_TODAY, clientTest: 'failed', message: 'Radarr can\'t resolve jack.' }),
    ].map(r => indexerPauseText(RADARR, r, NOW))
    for (const text of texts)
      expect(`${text?.title} ${text?.detail}`).not.toContain('Register again')
  })

  test('says nothing needs doing only when the pause is all that is wrong', () => {
    const notAlone = [
      registration({ indexerPausedUntil: LATER_TODAY, message: 'Restart the jack container to finish.' }),
      registration({ indexerPausedUntil: LATER_TODAY, clientTest: 'failed' }),
      registration({ indexerPausedUntil: LATER_TODAY, indexerTest: 'failed' }),
      registration({ indexerPausedUntil: LATER_TODAY, clientTest: 'skipped' }),
    ]
    for (const r of notAlone)
      expect(indexerPauseText(RADARR, r, NOW)?.detail).toBe('Radarr pauses an indexer after errors and resumes it by itself at that time.')
  })

  test('says the pause without an end when the *arr doesn\'t give one', () => {
    expect(indexerPauseText({ name: 'Sonarr', type: 'sonarr' }, registration({ indexerPaused: true }), NOW)).toEqual({
      title: 'Sonarr is skipping jack\'s indexer after earlier errors, so it won\'t find friends\' episodes for now.',
      detail: 'Sonarr resumes it by itself after a while, and jack resumes it once a friend adds new episodes. You don\'t need to do anything.',
    })
    expect(indexerPauseText(RADARR, registration({ indexerPaused: true, clientTest: 'failed' }), NOW)?.detail)
      .toBe('Radarr resumes it by itself after a while, and jack resumes it once a friend adds new movies.')
  })

  test('is null while the indexer isn\'t paused', () => {
    expect(indexerPauseText(RADARR, null, NOW)).toBeNull()
    expect(indexerPauseText(RADARR, registration(), NOW)).toBeNull()
    expect(indexerPauseText(RADARR, registration({ indexerPausedUntil: LATER_TODAY }), Date.parse(LATER_TODAY))).toBeNull()
  })
})

describe('a paused indexer', () => {
  const paused = registration({ indexerPausedUntil: LATER_TODAY })

  test('is a warning on the card, not a tick', () => {
    expect(registrationSummary(paused, NOW)).toEqual({
      parts: [{ text: 'indexer paused', tone: 'warning' }, { text: 'download client ✓', tone: 'ok' }],
      tone: 'warning',
    })
    expect(registrationStepTone('indexer', paused.indexer, 'ok', true)).toBe('warning')
    expect(registrationStepTone('downloadClient', paused.downloadClient, 'ok', true)).toBe('ok')
  })

  test('is ticked again once the pause is over', () => {
    expect(registrationSummary(paused, Date.parse(LATER_TODAY)).tone).toBe('ok')
  })

  test('is a warning too when the *arr doesn\'t say until when', () => {
    expect(registrationSummary(registration({ indexerPaused: true }), NOW)).toEqual({
      parts: [{ text: 'indexer paused', tone: 'warning' }, { text: 'download client ✓', tone: 'ok' }],
      tone: 'warning',
    })
    expect(registrationHeadline(registration({ indexerPaused: true }), RADARR, NOW).title)
      .toBe('Radarr is skipping jack\'s indexer after earlier errors, so it won\'t find friends\' movies for now.')
  })

  test('stays failed when its test failed', () => {
    const summary = registrationSummary(registration({ indexerTest: 'failed', indexerPausedUntil: LATER_TODAY }), NOW)
    expect(summary.parts[0]).toEqual({ text: 'indexer failed', tone: 'error' })
    expect(summary.tone).toBe('error')
  })

  test('heads the result instead of "jack is set up"', () => {
    expect(registrationHeadline(paused, RADARR, NOW)).toEqual({
      tone: 'warning',
      title: 'Radarr is skipping jack\'s indexer until 17:36, so it won\'t find friends\' movies before then.',
      description: 'Radarr pauses an indexer after errors and resumes it by itself at that time. You don\'t need to do anything.',
    })
  })

  // The toast after Register again words it the same way: right after the user
  // pressed it, it must not ask for it again.
  test('after Register again, gives the new end of the pause and no further advice', () => {
    const longer = registration({ indexerPausedUntil: new Date(2026, 9, 19, 20, 49).toISOString() })
    const { title, description } = registrationHeadline(longer, RADARR, NOW)
    expect(title).toBe('Radarr is skipping jack\'s indexer until 20:49, so it won\'t find friends\' movies before then.')
    expect(description).not.toContain('Register again')
  })

  test('follows the backend\'s message when there is one, without saying nothing needs doing', () => {
    const headline = registrationHeadline(registration({ clientTest: 'failed', message: 'Radarr can\'t resolve jack.', indexerPausedUntil: LATER_TODAY }), RADARR, NOW)
    expect(headline.tone).toBe('error')
    expect(headline.title).toBe('Radarr can\'t resolve jack.')
    expect(headline.description).toBe('Radarr is skipping jack\'s indexer until 17:36, so it won\'t find friends\' movies before then. Radarr pauses an indexer after errors and resumes it by itself at that time.')
  })
})

describe('registrationHeadline', () => {
  test('says both tests passed only when both ran', () => {
    expect(registrationHeadline(registration(), RADARR, NOW)).toEqual({
      tone: 'ok',
      title: 'jack is set up in Radarr.',
      description: 'Radarr tested jack\'s indexer and download client, and both work.',
    })
    expect(registrationHeadline(registration({ indexerTest: 'skipped' }), RADARR, NOW)).toEqual({ tone: 'ok', title: 'jack is set up in Radarr.', description: undefined })
  })

  test('falls back to a plain failure line', () => {
    expect(registrationHeadline(registration({ clientTest: 'failed' }), RADARR, NOW)).toEqual({
      tone: 'error',
      title: 'jack couldn\'t finish setting itself up in Radarr.',
      description: undefined,
    })
  })
})

describe('an indexer added but not tested', () => {
  test('reads as added, not as waiting for a restart', () => {
    expect(registrationSummary(registration({ indexerTest: 'skipped' }), NOW).parts[0]).toEqual({ text: 'indexer added', tone: 'ok' })
  })
})
