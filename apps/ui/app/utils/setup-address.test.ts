import type { DestinationRegistration, OverviewServerItem } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { addressFailures, addressProblemMessage, registrationAddressProblem, serverStepWithAddressFailures, withAddressFailures } from './setup-address'
import { setupInternalUrlStep, setupServerStep } from './setup-steps'

function registration(overrides: Partial<DestinationRegistration> = {}): DestinationRegistration {
  return {
    at: '2026-10-19T05:00:00.000Z',
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

// What Radarr 6.4.4 answers when jack creates its download client at an address
// Radarr can't reach: the create fails, so neither test runs.
function clientFailed(error: string): DestinationRegistration {
  return registration({
    downloadClient: { status: 'failed', error },
    indexer: { status: 'skipped', reason: 'client-failed' },
    clientTest: 'skipped',
    indexerTest: 'skipped',
    message: `jack couldn't add its download client to Radarr (${error}), so it left the indexer as it was. Register again.`,
  })
}

const UNRESOLVED = 'Unable to connect to qBittorrent (Name does not resolve (review-nonexistent-host:5225))'

function server(overrides: Partial<OverviewServerItem> = {}): OverviewServerItem {
  return {
    id: 'radarr',
    name: 'Radarr',
    url: 'http://radarr:7878',
    type: 'radarr',
    initialized: true,
    initializationError: null,
    source: true,
    destination: true,
    registration: registration(),
    lastContactAt: null,
    ...overrides,
  }
}

describe('registrationAddressProblem', () => {
  test('a network error from the *arr\'s test of the new item is an address problem', () => {
    expect(registrationAddressProblem(clientFailed(UNRESOLVED))).toBe('resolve')
    expect(registrationAddressProblem(clientFailed('Unable to connect to qBittorrent (Name or service not known (jack:5225))'))).toBe('resolve')
    expect(registrationAddressProblem(clientFailed('Unable to connect to qBittorrent (Connection refused (192.168.1.10:5225))'))).toBe('refused')
    expect(registrationAddressProblem(clientFailed('Unable to connect to qBittorrent (No route to host (192.168.1.10:5225))'))).toBe('unreachable')
    expect(registrationAddressProblem(clientFailed('Unable to connect to qBittorrent (The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.)'))).toBe('timeout')
    // jack gave up waiting while Radarr still tried an address nothing answers on.
    expect(registrationAddressProblem(clientFailed('The request timed out'))).toBe('timeout')
  })

  test('the indexer step counts too', () => {
    const r = registration({ indexer: { status: 'failed', error: 'Unable to connect to indexer (Connection refused (192.168.1.10:5225))' }, indexerTest: 'skipped' })
    expect(registrationAddressProblem(r)).toBe('refused')
  })

  test('other failures say nothing about the address', () => {
    // Radarr reached jack: an HTTP error, a rejected key, an empty feed.
    expect(registrationAddressProblem(clientFailed('Unable to connect to qBittorrent (HTTP request failed: [404:NotFound] [GET] at [http://jack:5225/api/v2/app/webapiVersion])'))).toBeNull()
    expect(registrationAddressProblem(clientFailed('Authentication failure'))).toBeNull()
    expect(registrationAddressProblem(registration({ indexer: { status: 'failed', error: 'Query successful, but no results in the configured categories were returned from your indexer.' } }))).toBeNull()
    // jack's own error reaching the *arr.
    expect(registrationAddressProblem(clientFailed('Unable to connect. Is the computer able to access the url?'))).toBeNull()
    expect(registrationAddressProblem(registration())).toBeNull()
    expect(registrationAddressProblem(registration({ reason: 'downloads-off', downloadClient: { status: 'skipped', reason: 'downloads-off' }, indexer: { status: 'skipped', reason: 'downloads-off' } }))).toBeNull()
  })
})

describe('addressProblemMessage', () => {
  test('names the server and the part of the address that failed', () => {
    expect(addressProblemMessage('resolve', 'Radarr', 'http://review-nonexistent-host:5225'))
      .toBe('jack couldn\'t add itself to Radarr: Radarr can\'t find review-nonexistent-host. Use your server\'s IP address instead.')
    expect(addressProblemMessage('refused', 'Sonarr', 'http://192.168.1.10:5225'))
      .toBe('jack couldn\'t add itself to Sonarr: Sonarr reached 192.168.1.10, but nothing answered on 192.168.1.10:5225. Check the port.')
    expect(addressProblemMessage('timeout', 'Radarr', 'http://192.168.1.10:5225')).toContain('Radarr\'s test of 192.168.1.10:5225 took too long')
    expect(addressProblemMessage('unreachable', 'Radarr', 'not a url')).toContain('no route to not a url')
  })
})

describe('addressFailures', () => {
  test('lists receiving servers that couldn\'t reach the address, in plain words', () => {
    const servers = [server({ registration: clientFailed(UNRESOLVED) }), server({ id: 'sonarr', name: 'Sonarr', registration: registration() })]
    expect(addressFailures(servers, 'http://review-nonexistent-host:5225')).toEqual([
      { id: 'radarr', name: 'Radarr', message: 'jack couldn\'t add itself to Radarr: Radarr can\'t find review-nonexistent-host. Use your server\'s IP address instead.' },
    ])
  })

  test('keeps jack\'s own message when it already names the address setting', () => {
    const message = 'Radarr can\'t resolve jack. Use your server\'s IP in Address Radarr/Sonarr use to reach jack.'
    const servers = [server({ registration: { ...clientFailed(UNRESOLVED), message } })]
    expect(addressFailures(servers, 'http://jack:5225')[0]?.message).toBe(message)
  })

  test('skips servers that only share, and servers without a registration', () => {
    expect(addressFailures([server({ destination: false, registration: clientFailed(UNRESOLVED) }), server({ registration: null })], 'http://jack:5225')).toEqual([])
  })
})

describe('step 1 and step 3 after a first registration that couldn\'t reach the address', () => {
  const registers = () => true
  const servers = [server({ registration: clientFailed(UNRESOLVED) })]

  function steps(internalUrl: string, confirmedUrl: string | null = null) {
    const failures = addressFailures(servers, internalUrl)
    return {
      internalUrl: withAddressFailures(setupInternalUrlStep({ internalUrl, servers, autoRegisters: registers, shareOnly: false, confirmedUrl }), failures),
      server: serverStepWithAddressFailures(setupServerStep({ servers, autoRegisters: registers, shareOnly: false, downloadsOn: true }), failures),
    }
  }

  test('the template\'s example IP asks to check the address instead of waiting for a test', () => {
    const { internalUrl, server: step3 } = steps('http://192.168.1.10:5225')
    expect(internalUrl).toMatchObject({ state: 'check', reason: 'failed' })
    expect(internalUrl.failures.map(f => f.id)).toEqual(['radarr'])
    expect(step3).toMatchObject({ state: 'open', reason: 'not-added' })
    expect(step3.problems[0]?.message).toContain('once Radarr can reach jack (step 1)')
  })

  test('so does a confirmed default address that Radarr can\'t resolve', () => {
    expect(steps('http://jack:5225', 'http://jack:5225').internalUrl).toMatchObject({ state: 'check', reason: 'failed' })
    expect(steps('http://jack:5225').internalUrl).toMatchObject({ state: 'check', reason: 'failed' })
  })
})

describe('withAddressFailures', () => {
  const failure = { id: 'sonarr', name: 'Sonarr', message: 'jack couldn\'t add itself to Sonarr: …' }
  const base = { reachedBy: [], failures: [], manual: [] }

  test('a server that reached jack settles the address', () => {
    const reached = { ...base, state: 'done' as const, reason: 'reached' as const, reachedBy: ['Radarr'] }
    expect(withAddressFailures(reached, [failure])).toBe(reached)
  })

  test('adds to failed tests without listing a server twice', () => {
    const testFailed = { ...base, state: 'check' as const, reason: 'failed' as const, failures: [{ id: 'radarr', name: 'Radarr', message: 'Radarr couldn\'t reach jack.' }] }
    expect(withAddressFailures(testFailed, [failure, { ...failure, id: 'radarr' }]).failures.map(f => f.id)).toEqual(['radarr', 'sonarr'])
  })

  test('outweighs an untestable or confirmed address', () => {
    expect(withAddressFailures({ ...base, state: 'check', reason: 'untestable', manual: ['Sonarr'] }, [failure])).toMatchObject({ state: 'check', reason: 'failed' })
    expect(withAddressFailures({ ...base, state: 'done', reason: 'confirmed', manual: ['Sonarr'] }, [failure])).toMatchObject({ state: 'check', reason: 'failed' })
  })

  test('without failures the step stays as it was', () => {
    const untested = { ...base, state: 'untested' as const, reason: 'untested' as const }
    expect(withAddressFailures(untested, [])).toBe(untested)
  })
})

describe('serverStepWithAddressFailures', () => {
  test('leaves other servers\' problems and other reasons alone', () => {
    const step = {
      state: 'open' as const,
      reason: 'not-added' as const,
      names: ['Radarr', 'Sonarr'],
      problems: [{ id: 'radarr', name: 'Radarr', message: 'raw' }, { id: 'sonarr', name: 'Sonarr', message: 'jack couldn\'t add its indexer to Sonarr (boom). Register again.' }],
    }
    const result = serverStepWithAddressFailures(step, [{ id: 'radarr', name: 'Radarr', message: 'x' }])
    expect(result.problems[0]?.message).toContain('once Radarr can reach jack')
    expect(result.problems[1]).toEqual(step.problems[1]!)
    const done = { state: 'done' as const, reason: null, names: ['Radarr'], problems: [] }
    expect(serverStepWithAddressFailures(done, [{ id: 'radarr', name: 'Radarr', message: 'x' }])).toBe(done)
  })
})
