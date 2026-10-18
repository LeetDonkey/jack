import { describe, expect, test } from 'bun:test'
import { docsUrl } from './docs'
import { logHelp } from './logFormat'
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
