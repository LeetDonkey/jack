import { describe, expect, test } from 'bun:test'
import { pendingRestart, stableStringify } from './restart-pending'

describe('pendingRestart', () => {
  const boot = {
    jack: { internalUrl: 'http://jack:5225', apiKey: { env: 'JACK_KEY' }, tmdbApiKey: { file: '/run/secrets/tmdb' } },
    downloads: { completedPath: '/data/jack', maxConcurrentDownloads: 3 },
  }

  test('nothing is pending while the config matches the boot config', () => {
    expect(pendingRestart(boot, structuredClone(boot))).toEqual([])
  })

  test('an unchanged {env} or {file} reference is not a change, whatever key order', () => {
    const current = {
      jack: { tmdbApiKey: { file: '/run/secrets/tmdb' }, apiKey: { env: 'JACK_KEY' }, internalUrl: 'http://other:5225' },
      downloads: { maxConcurrentDownloads: 3, completedPath: '/data/jack' },
    }
    expect(pendingRestart(boot, current)).toEqual([])
  })

  test('names changed keys, but not the internal URL or live downloads keys', () => {
    const current = {
      jack: { internalUrl: 'http://192.168.1.10:5225', apiKey: { env: 'OTHER' }, tmdbApiKey: 'plain-key' },
      downloads: { completedPath: '/data/other', maxConcurrentDownloads: 8, unlinkImportedFiles: true, retryWindowMs: 0 },
    }
    expect(pendingRestart(boot, current)).toEqual(['downloads.completedPath', 'downloads.retries', 'jack.tmdbApiKey', 'jack.apiKey'])
  })

  test('downloads added since boot is one reason, whatever it contains', () => {
    const { downloads: _downloads, ...withoutDownloads } = boot
    expect(pendingRestart(withoutDownloads, { ...boot, downloads: { completedPath: '/data/jack', retryWindowMs: 5 } })).toEqual(['downloads'])
  })

  test('writing a default value explicitly is not a change', () => {
    expect(pendingRestart(boot, { ...boot, downloads: { ...boot.downloads, maxDownloadAttempts: 13 } })).toEqual([])
  })
})

describe('stableStringify', () => {
  test('sorts keys at every depth and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":2,"y":1}]},"b":1}')
  })
})
