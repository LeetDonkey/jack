import type { DestinationRegistration, OverviewServerItem } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { sameInternalUrl, setupDownloadsStep, setupInternalUrlStep, setupServerStep, shareOnlyOfferStep } from './setup-steps'

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

const registers = () => true
const manual = () => false
const unknown = () => undefined

describe('setupInternalUrlStep', () => {
  const base = { internalUrl: 'http://192.168.1.10:5225', servers: [] as OverviewServerItem[], autoRegisters: registers, shareOnly: false, confirmedUrl: null }

  test('a passing test marks it done and names who reached jack', () => {
    const step = setupInternalUrlStep({ ...base, servers: [server({ registration: registration({ clientTest: 'skipped', indexerTest: 'ok' }) })] })
    expect(step).toMatchObject({ state: 'done', reason: 'reached', reachedBy: ['Radarr'] })
  })

  test('a failed test asks to check it, with the *arr\'s message', () => {
    const step = setupInternalUrlStep({ ...base, servers: [server({ registration: registration({ clientTest: 'failed', indexerTest: 'skipped', message: 'Radarr couldn\'t reach jack at http://x:5225.' }) })] })
    expect(step.state).toBe('check')
    expect(step.reason).toBe('failed')
    expect(step.failures).toEqual([{ id: 'radarr', name: 'Radarr', message: 'Radarr couldn\'t reach jack at http://x:5225.' }])
  })

  test('a non-default address nothing has tested is untested, not done', () => {
    expect(setupInternalUrlStep(base)).toMatchObject({ state: 'untested', reason: 'untested' })
    // Still registering: the test is on its way.
    expect(setupInternalUrlStep({ ...base, servers: [server({ registration: null })] }).state).toBe('untested')
  })

  test('the default address asks whether Radarr/Sonarr are on the jack network', () => {
    expect(setupInternalUrlStep({ ...base, internalUrl: 'http://jack:5225/' })).toMatchObject({ state: 'check', reason: 'default' })
  })

  test('a confirmed default waits for the test like any other address', () => {
    const step = setupInternalUrlStep({ ...base, internalUrl: 'http://jack:5225', confirmedUrl: 'http://jack:5225' })
    expect(step).toMatchObject({ state: 'untested', reason: 'untested' })
  })

  test('with auto-register off everywhere, nothing tests it, so the user confirms it', () => {
    const servers = [server({ registration: null })]
    expect(setupInternalUrlStep({ ...base, servers, autoRegisters: manual })).toMatchObject({ state: 'check', reason: 'untestable', manual: ['Radarr'] })
    expect(setupInternalUrlStep({ ...base, servers, autoRegisters: manual, confirmedUrl: 'http://192.168.1.10:5225/' }))
      .toMatchObject({ state: 'done', reason: 'confirmed', manual: ['Radarr'] })
    // A confirmation of another address doesn't count.
    expect(setupInternalUrlStep({ ...base, servers, autoRegisters: manual, confirmedUrl: 'http://jack:5225' }).reason).toBe('untestable')
  })

  test('auto-register unknown or on for one receiver means a test is still coming', () => {
    const servers = [server({ id: 'a', registration: null }), server({ id: 'b', name: 'Sonarr', registration: null })]
    expect(setupInternalUrlStep({ ...base, servers, autoRegisters: unknown }).reason).toBe('untested')
    expect(setupInternalUrlStep({ ...base, servers, autoRegisters: id => id === 'b' }).reason).toBe('untested')
  })

  test('the default address still asks first when auto-register is off', () => {
    const servers = [server({ registration: null })]
    expect(setupInternalUrlStep({ ...base, internalUrl: 'http://jack:5225', servers, autoRegisters: manual }).reason).toBe('default')
  })

  test('someone who only shares skips it', () => {
    expect(setupInternalUrlStep({ ...base, internalUrl: 'http://jack:5225', shareOnly: true })).toMatchObject({ state: 'skipped', reason: 'share-only' })
  })
})

describe('sameInternalUrl', () => {
  test('ignores spaces and trailing slashes', () => {
    expect(sameInternalUrl(' http://10.0.0.2:5225/ ', 'http://10.0.0.2:5225')).toBe(true)
    expect(sameInternalUrl('http://10.0.0.2:5225', 'http://10.0.0.3:5225')).toBe(false)
  })
})

describe('setupDownloadsStep', () => {
  test('done when on, skipped for someone who only shares, open otherwise', () => {
    expect(setupDownloadsStep(true, false)).toBe('done')
    expect(setupDownloadsStep(true, true)).toBe('done')
    expect(setupDownloadsStep(false, true)).toBe('skipped')
    expect(setupDownloadsStep(false, false)).toBe('open')
  })
})

describe('setupServerStep', () => {
  const base = { servers: [] as OverviewServerItem[], autoRegisters: registers, shareOnly: false, downloadsOn: true }

  test('no server, or none that receives downloads', () => {
    expect(setupServerStep(base)).toMatchObject({ state: 'open', reason: 'none' })
    expect(setupServerStep({ ...base, servers: [server({ destination: false, registration: null })] })).toMatchObject({ state: 'open', reason: 'no-destination' })
  })

  test('done once jack\'s download client and indexer are both in a receiver', () => {
    expect(setupServerStep({ ...base, servers: [server()] })).toMatchObject({ state: 'done', names: ['Radarr'] })
  })

  test('a failed indexer keeps it open with what went wrong', () => {
    const failed = server({ registration: registration({ indexer: { status: 'failed', error: 'Query successful, but no results' }, indexerTest: 'skipped', message: 'jack couldn\'t add its indexer to Radarr.' }) })
    const step = setupServerStep({ ...base, servers: [failed] })
    expect(step).toMatchObject({ state: 'open', reason: 'not-added' })
    expect(step.problems).toEqual([{ id: 'radarr', name: 'Radarr', message: 'jack couldn\'t add its indexer to Radarr.' }])
    // Without jack's own message, the line names the part that is missing.
    const bare = server({ registration: registration({ indexer: { status: 'failed' }, message: null }) })
    expect(setupServerStep({ ...base, servers: [bare] }).problems[0]!.message).toBe('jack couldn\'t add its indexer to Radarr.')
    const noClient = server({ registration: registration({ downloadClient: { status: 'failed' }, indexer: { status: 'skipped', reason: 'client-failed' }, message: null }) })
    expect(setupServerStep({ ...base, servers: [noClient] }).problems[0]!.message).toBe('jack couldn\'t add its download client to Radarr.')
  })

  test('one fully set up receiver is enough', () => {
    const failed = server({ id: 'b', name: 'Sonarr', registration: registration({ indexer: { status: 'failed' } }) })
    expect(setupServerStep({ ...base, servers: [server(), failed] })).toMatchObject({ state: 'done', names: ['Radarr'] })
  })

  test('a server jack doesn\'t add itself to counts as it is', () => {
    expect(setupServerStep({ ...base, servers: [server({ registration: null })], autoRegisters: manual })).toMatchObject({ state: 'done' })
  })

  test('pending while connecting or registering, open when unreachable', () => {
    expect(setupServerStep({ ...base, servers: [server({ initialized: false, registration: null })] })).toMatchObject({ state: 'pending', reason: null })
    expect(setupServerStep({ ...base, servers: [server({ initialized: false, initializationError: 'ECONNREFUSED', registration: null })] })).toMatchObject({ state: 'open', reason: 'unreachable' })
    expect(setupServerStep({ ...base, servers: [server({ registration: null })] })).toMatchObject({ state: 'pending', reason: 'registering' })
  })

  test('downloads off: jack added nothing', () => {
    const off = server({ registration: registration({ reason: 'downloads-off', downloadClient: { status: 'skipped', reason: 'downloads-off' }, indexer: { status: 'skipped', reason: 'downloads-off' } }) })
    expect(setupServerStep({ ...base, servers: [off], downloadsOn: false })).toMatchObject({ state: 'open', reason: 'downloads-off' })
    // Turned on since: Register again adds jack.
    expect(setupServerStep({ ...base, servers: [off] }).problems[0]!.message).toContain('Register again')
  })

  test('someone who only shares needs a server that shares instead', () => {
    const sharer = server({ destination: false, registration: null })
    expect(setupServerStep({ ...base, shareOnly: true, servers: [sharer] })).toMatchObject({ state: 'done', names: ['Radarr'] })
    expect(setupServerStep({ ...base, shareOnly: true, servers: [server({ source: false, destination: false, registration: null })] }))
      .toMatchObject({ state: 'open', reason: 'no-source' })
  })
})

describe('shareOnlyOfferStep', () => {
  test('offers "I only share" once, on the first open step it answers', () => {
    // Downloads off and nothing receives downloads: step 2 only, not step 3 too.
    expect(shareOnlyOfferStep('open', { reason: 'no-destination' }, 0)).toBe('downloads')
    expect(shareOnlyOfferStep('open', { reason: 'none' }, 0)).toBe('downloads')
    expect(shareOnlyOfferStep('done', { reason: 'no-destination' }, 0)).toBe('servers')
  })

  test('offers nothing when no step asks for downloading', () => {
    expect(shareOnlyOfferStep('done', { reason: null }, 0)).toBeNull()
    expect(shareOnlyOfferStep('skipped', { reason: 'no-source' }, 0)).toBeNull()
  })

  test('offers nothing while a Radarr/Sonarr receives downloads, where it would do nothing', () => {
    expect(shareOnlyOfferStep('open', { reason: 'downloads-off' }, 1)).toBeNull()
  })
})
