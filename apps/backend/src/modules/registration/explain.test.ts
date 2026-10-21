import { describe, expect, test } from 'bun:test'
import { explainArrTestFailure, isNoResultsFailure } from './explain'

describe('explainArrTestFailure', () => {
  const ctx = { arrName: 'Radarr', internalUrl: 'http://jack:5225', lanOnly: true }

  test.each([
    ['Unable to connect to qBittorrent (Resource temporarily unavailable (jack:5225))', 'Radarr can\'t resolve jack. Use your server\'s IP in Address Radarr/Sonarr use to reach jack.'],
    ['Unable to connect to indexer: Connection refused (jack:5225)', 'Radarr reached jack, but nothing answered on jack:5225. Check the port in Address Radarr/Sonarr use to reach jack.'],
    ['Unable to connect to qBittorrent (No route to host)', 'Radarr has no route to jack. Check Address Radarr/Sonarr use to reach jack. If Radarr runs on br0, turn on host access to custom networks in Unraid\'s Docker settings.'],
    ['Unable to connect to indexer, check the log above the ValidationFailure for more details. HTTP request failed: [401:Unauthorized] [GET] at [http://jack:5225/torznab/api]', 'jack rejected Radarr\'s key. To give Radarr a new one, use Register again on Radarr\'s card.'],
  ])('%s', (text, expected) => {
    expect(explainArrTestFailure(text, ctx)).toBe(expected)
  })

  // jack answers 403 to an address outside the LAN before it looks at the key, and
  // Register again can't change the address.
  const outsideLan = 'jack refused Radarr, probably because Radarr reaches jack from outside your LAN. Use your server\'s LAN IP in Address Radarr/Sonarr use to reach jack, or add Radarr\'s address under Settings -> Sharing -> Security -> Reverse proxy and exceptions -> Radarr/Sonarr outside your LAN.'
  test.each([
    'Authentication failure (Please verify your username and password.)',
    'Unable to connect to indexer, check the log above the ValidationFailure for more details. HTTP request failed: [403:Forbidden] [GET] at [https://jack.example.com/torznab/api]',
  ])('a refusal while the APIs answer only the LAN: %s', (text) => {
    expect(explainArrTestFailure(text, ctx)).toBe(outsideLan)
    expect(explainArrTestFailure(text, { ...ctx, lanOnly: false })).toBe('jack rejected Radarr\'s key. To give Radarr a new one, use Register again on Radarr\'s card.')
  })

  test('passes unknown failures through', () => {
    expect(explainArrTestFailure('Category jack-abc does not exist', ctx)).toBe('Radarr couldn\'t use jack: Category jack-abc does not exist')
  })
})

describe('isNoResultsFailure', () => {
  test('matches the Torznab "no results" test failure', () => {
    expect(isNoResultsFailure('Query successful, but no results in the configured categories were returned from your indexer.')).toBe(true)
    expect(isNoResultsFailure('Unable to connect to indexer')).toBe(false)
  })
})
