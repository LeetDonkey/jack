import { describe, expect, test } from 'bun:test'
import { buildIdentity, handshakeBuild, versionInfo } from './build'
import { PROTOCOL_VERSION } from './version'

describe('buildIdentity', () => {
  test('reads the revision and build date the image was built with', () => {
    expect(buildIdentity({ JACK_BUILD_REVISION: ' 4ca4a2a1f0 ', JACK_BUILD_DATE: '2026-10-17T08:30:00Z' }))
      .toEqual({ revision: '4ca4a2a1f0', buildDate: '2026-10-17T08:30:00.000Z' })
  })

  test('reports nulls for a build without them, or with values that are no revision or date', () => {
    expect(buildIdentity({})).toEqual({ revision: null, buildDate: null })
    expect(buildIdentity({ JACK_BUILD_REVISION: '', JACK_BUILD_DATE: '' })).toEqual({ revision: null, buildDate: null })
    expect(buildIdentity({ JACK_BUILD_REVISION: 'abc def', JACK_BUILD_DATE: 'yesterday' })).toEqual({ revision: null, buildDate: null })
  })

  test('versionInfo adds the protocol version', () => {
    expect(versionInfo({ JACK_BUILD_REVISION: 'dev' })).toEqual({ version: PROTOCOL_VERSION, revision: 'dev', buildDate: null })
  })
})

describe('handshakeBuild', () => {
  test('reads the optional build from a peer\'s handshake', () => {
    expect(handshakeBuild({ name: 'jack', version: '0.1.0', build: { revision: '4ca4a2a', buildDate: '2026-10-17T08:30:00.000Z' } }))
      .toEqual({ revision: '4ca4a2a', buildDate: '2026-10-17T08:30:00.000Z' })
  })

  test('is null for an older jack, and drops values a peer shouldn\'t send', () => {
    expect(handshakeBuild({ name: 'jack', version: '0.1.0' })).toBeNull()
    expect(handshakeBuild(null)).toBeNull()
    expect(handshakeBuild({ build: 'x' })).toBeNull()
    expect(handshakeBuild({ build: { revision: '<script>', buildDate: 42 } })).toBeNull()
    expect(handshakeBuild({ build: { revision: 'a'.repeat(65), buildDate: '2026-10-17' } })).toEqual({ revision: null, buildDate: '2026-10-17T00:00:00.000Z' })
  })
})
