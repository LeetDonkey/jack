import { describe, expect, test } from 'bun:test'
import { explainArrTestFailure, isNoResultsFailure } from './explain'

describe('explainArrTestFailure', () => {
  const ctx = { arrName: 'Radarr', internalUrl: 'http://jack:5225' }

  test.each([
    ['Unable to connect to qBittorrent (Resource temporarily unavailable (jack:5225))', 'Radarr can\'t resolve jack. Use your server\'s IP in Address Radarr/Sonarr use to reach jack.'],
    ['Unable to connect to indexer: Connection refused (jack:5225)', 'Radarr reached jack, but nothing answered on jack:5225. Check the port in Address Radarr/Sonarr use to reach jack.'],
    ['Unable to connect to qBittorrent (No route to host)', 'Radarr has no route to jack. Check Address Radarr/Sonarr use to reach jack. If Radarr runs on br0, turn on host access to custom networks in Unraid\'s Docker settings.'],
    ['Authentication failure (Please verify your username and password.)', 'jack rejected Radarr\'s key. Register again to give Radarr a new one.'],
  ])('%s', (text, expected) => {
    expect(explainArrTestFailure(text, ctx)).toBe(expected)
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
