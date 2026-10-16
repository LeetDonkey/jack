import { describe, expect, test } from 'bun:test'
import { IdleTimeoutError } from '../lib/errors/IdleTimeoutError'
import { IncompleteDownloadError } from '../lib/errors/IncompleteDownloadError'
import { isTransientDownloadError } from '../modules/downloads/retry-policy'

describe('isTransientDownloadError', () => {
  test('IdleTimeoutError is transient (retryable)', () => {
    expect(isTransientDownloadError(new IdleTimeoutError('stalled'))).toBe(true)
  })

  test('IncompleteDownloadError is transient (retryable)', () => {
    expect(isTransientDownloadError(new IncompleteDownloadError('short'))).toBe(true)
  })

  test('a plain AbortError (manual cancel, not idle) is not transient', () => {
    expect(isTransientDownloadError(new DOMException('aborted', 'AbortError'))).toBe(false)
  })

  test('a connection dropped mid-stream (ECONNRESET) is transient', () => {
    const error = Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' })
    expect(isTransientDownloadError(error)).toBe(true)
  })

  test('Bun fetch connection codes are transient', () => {
    for (const code of ['ConnectionClosed', 'ConnectionRefused'])
      expect(isTransientDownloadError(Object.assign(new Error('fetch failed'), { code }))).toBe(true)
  })

  test('filesystem error codes are not transient', () => {
    const error = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    expect(isTransientDownloadError(error)).toBe(false)
  })
})
