import { describe, expect, test } from 'bun:test'
import { ConnectorInitializationError } from '../errors/ConnectorInitializationError'
import { FetchError } from '../errors/FetchError'
import { IncompatiblePeerError } from '../errors/IncompatiblePeerError'
import { classifyPeerError, peerErrorStatus } from './peer-errors'

function fetchError(status: number) {
  return new FetchError('Failed to fetch url', new Response(null, { status }))
}

function bunError(code: string, message = 'Unable to connect. Is the computer able to access the url?') {
  return Object.assign(new Error(message), { code })
}

async function resolvesNothing(): Promise<never> {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
}

async function resolvesAll() {
  return [{ address: '10.0.0.5', family: 4 }]
}

describe('classifyPeerError', () => {
  test('HTTP answers', async () => {
    expect(await classifyPeerError(fetchError(401), 'https://a.test')).toBe('unauthorized')
    expect(await classifyPeerError(fetchError(403), 'https://a.test')).toBe('forbidden')
    expect(await classifyPeerError(fetchError(404), 'https://a.test')).toBe('incompatible')
    expect(await classifyPeerError(fetchError(502), 'https://a.test')).toBe('unavailable')
    expect(await classifyPeerError(fetchError(418), 'https://a.test')).toBe('unknown')
    expect(await classifyPeerError(new IncompatiblePeerError('too old'), 'https://a.test')).toBe('incompatible')
  })

  test('looks through the wrapper of an interactive add', async () => {
    const wrapped = new ConnectorInitializationError('Could not connect to peer "A": Unauthorized', fetchError(401))
    expect(await classifyPeerError(wrapped, 'https://a.test')).toBe('unauthorized')
    expect(peerErrorStatus(wrapped)).toBe(401)
    expect(peerErrorStatus(new Error('x'))).toBeNull()
  })

  test('a 404 on /handshake is incompatible and keeps the status the peer or its proxy answered with', async () => {
    // What PeerConnector.runInit throws for a missing /handshake, wrapped by an interactive add.
    const wrapped = new ConnectorInitializationError('Could not connect to peer "A": no handshake endpoint', new IncompatiblePeerError('no handshake endpoint', fetchError(404)))
    expect(await classifyPeerError(wrapped, 'https://a.test')).toBe('incompatible')
    expect(peerErrorStatus(wrapped)).toBe(404)
    // A version too old to talk to: the peer answered, but with no error status.
    expect(peerErrorStatus(new ConnectorInitializationError('too old', new IncompatiblePeerError('too old')))).toBeNull()
  })

  test('a timeout', async () => {
    expect(await classifyPeerError(new DOMException('The operation timed out.', 'TimeoutError'), 'https://a.test')).toBe('timeout')
  })

  test('a refused connection is dns when the host does not resolve', async () => {
    const error = bunError('ConnectionRefused')
    expect(await classifyPeerError(error, 'https://jack.example.com', resolvesNothing)).toBe('dns')
    expect(await classifyPeerError(error, 'https://jack.example.com', resolvesAll)).toBe('refused')
    // An IP address needs no lookup.
    expect(await classifyPeerError(error, 'http://192.168.0.20:5225', resolvesNothing)).toBe('refused')
    expect(await classifyPeerError(bunError('ENOTFOUND'), 'https://x.test', resolvesAll)).toBe('dns')
  })

  test('certificates, cut connections and anything else', async () => {
    expect(await classifyPeerError(bunError('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'), 'https://a.test')).toBe('tls')
    expect(await classifyPeerError(bunError('ERR_TLS_CERT_ALTNAME_INVALID'), 'https://a.test')).toBe('tls')
    expect(await classifyPeerError(bunError('ECONNRESET', 'socket hang up'), 'https://a.test')).toBe('unavailable')
    expect(await classifyPeerError(new Error('something else'), 'https://a.test')).toBe('unknown')
    expect(await classifyPeerError('not an error', 'https://a.test')).toBe('unknown')
  })
})
