import type { DestinationRegistration } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { emptyFeedNote, registrationResultHeadline } from './indexer-feed'

const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const LATER = '2026-10-19T15:00:00.000Z'
const RADARR = { name: 'Radarr', type: 'radarr' }

function registration(overrides: Partial<DestinationRegistration> = {}): DestinationRegistration {
  return {
    at: '2026-10-19T11:59:00.000Z',
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

describe('emptyFeedNote', () => {
  test('no friends: says why the *arr\'s Test fails and that it is normal', () => {
    const note = emptyFeedNote(registration(), RADARR, 0, NOW)
    expect(note?.title).toBe('The Test button on jack\'s indexer in Radarr fails for now')
    expect(note?.description).toBe('You have no friends in jack yet, so jack\'s indexer has no movies to list, and Radarr reports "no results". That\'s normal. Pressing Test can make Radarr skip jack\'s indexer for a while, so leave it until a friend shares movies.')
    expect(emptyFeedNote(registration(), { name: 'Sonarr 4K', type: 'sonarr' }, 0, NOW)?.description).toContain('has no episodes to list, and Sonarr 4K reports')
  })

  test('the result says the *arr reached jack, not that the indexer works', () => {
    const note = emptyFeedNote(registration(), RADARR, 0, NOW)
    expect(note?.headline).toBe('Radarr reached jack\'s indexer and download client.')
    expect(note?.indexerDetail).toBe('Added. Radarr reached it.')
    expect(`${note?.headline} ${note?.indexerDetail}`).not.toContain('work')
  })

  // Friends' releases may fill the feed, and the page can't tell without
  // loading their libraries.
  test('nothing with friends, or while their number is unknown', () => {
    expect(emptyFeedNote(registration(), RADARR, 2, NOW)).toBeNull()
    expect(emptyFeedNote(registration(), RADARR, null, NOW)).toBeNull()
  })

  test('nothing when the indexer or its test didn\'t pass, or the *arr skips it', () => {
    const others = [
      registration({ indexer: { status: 'failed', error: 'boom' } }),
      registration({ indexer: { status: 'skipped', reason: 'downloads-off' }, indexerTest: 'skipped' }),
      registration({ indexerTest: 'failed' }),
      registration({ indexerTest: 'skipped' }),
      registration({ indexerPaused: true }),
      registration({ indexerPausedUntil: LATER }),
    ]
    for (const r of others)
      expect(emptyFeedNote(r, RADARR, 0, NOW)).toBeNull()
  })
})

describe('registrationResultHeadline', () => {
  test('no friends: the *arr reached jack, instead of "both work"', () => {
    expect(registrationResultHeadline(registration(), RADARR, 0, NOW)).toEqual({
      tone: 'ok',
      title: 'jack is set up in Radarr.',
      description: 'Radarr reached jack\'s indexer and download client.',
    })
  })

  test('with friends, or their number unknown, as registrationHeadline says it', () => {
    for (const friends of [1, null]) {
      expect(registrationResultHeadline(registration(), RADARR, friends, NOW).description)
        .toBe('Radarr tested jack\'s indexer and download client, and both work.')
    }
  })

  test('leaves a headline that doesn\'t say both work as it is', () => {
    expect(registrationResultHeadline(registration({ clientTest: 'failed' }), RADARR, 0, NOW).title)
      .toBe('jack couldn\'t finish setting itself up in Radarr.')
    expect(registrationResultHeadline(registration({ indexerPausedUntil: LATER }), RADARR, 0, NOW).tone).toBe('warning')
  })
})
