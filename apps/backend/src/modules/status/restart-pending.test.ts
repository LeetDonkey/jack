import { describe, expect, test } from 'bun:test'
import { DownloadsConfig } from '../../lib/config'
import { IMPORT_DOWNLOAD_KEYS, LIVE_DOWNLOAD_KEYS, pendingRestart, stableStringify } from './restart-pending'

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

  test('a retry knob and an import knob are separate reasons', () => {
    const changed = (downloads: Record<string, unknown>) => pendingRestart(boot, { ...boot, downloads: { ...boot.downloads, ...downloads } })
    expect(changed({ idleTimeoutMs: 120_000 })).toEqual(['downloads.retries'])
    expect(changed({ importPollIntervalMs: 60_000 })).toEqual(['downloads.import'])
    expect(changed({ retryBaseDelayMs: 5000, manualImportBackoffMaxMs: 60_000 })).toEqual(['downloads.retries', 'downloads.import'])
  })

  test('a new downloads key has to be sorted into retries or import here', () => {
    const keys = Object.keys(DownloadsConfig.shape)
    expect([...IMPORT_DOWNLOAD_KEYS].filter(key => !keys.includes(key))).toEqual([])
    expect([...LIVE_DOWNLOAD_KEYS].filter(key => !keys.includes(key))).toEqual([])
    // The rest, read at startup, are the retry and timeout knobs.
    expect(keys.filter(key => key !== 'completedPath' && !LIVE_DOWNLOAD_KEYS.has(key) && !IMPORT_DOWNLOAD_KEYS.has(key)).sort())
      .toEqual(['idleTimeoutMs', 'maxDownloadAttempts', 'retryBaseDelayMs', 'retryMaxDelayMs', 'retryWindowMs'])
  })

  test('downloads added since boot is one reason, whatever it contains', () => {
    const { downloads: _downloads, ...withoutDownloads } = boot
    expect(pendingRestart(withoutDownloads, { ...boot, downloads: { completedPath: '/data/jack', retryWindowMs: 5 } })).toEqual(['downloads'])
  })

  test('writing a default value explicitly is not a change', () => {
    expect(pendingRestart(boot, { ...boot, downloads: { ...boot.downloads, maxDownloadAttempts: 13 } })).toEqual([])
  })

  test('pausing downloads applies at once', () => {
    expect(pendingRestart(boot, { ...boot, downloads: { ...boot.downloads, pausedUntil: 'indefinite' } })).toEqual([])
  })
})

describe('stableStringify', () => {
  test('sorts keys at every depth and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":2,"y":1}]},"b":1}')
  })
})
