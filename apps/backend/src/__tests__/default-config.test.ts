import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { jsonc } from 'jsonc'
import { createDefaultAppConfig, getAppConfig, internalUrlFromEnv, MIGRATIONS } from '../lib/config'
import { logger } from '../logger'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'jack-default-'))
  dirs.push(dir)
  return dir
}

async function readConfig(path: string) {
  return jsonc.parse(await Bun.file(path).text()) as { version: number, jack: { internalUrl: string }, downloads?: { completedPath: string } }
}

describe('createDefaultAppConfig', () => {
  test('turns downloads on when the downloads folder exists and is writable', async () => {
    const dir = await tempDir()
    const downloadsPath = join(dir, 'downloads')
    await mkdir(downloadsPath)
    const path = join(dir, 'config.jsonc')

    await createDefaultAppConfig(path, { downloadsPath })

    expect(await readConfig(path)).toEqual({
      version: MIGRATIONS.length,
      jack: { internalUrl: 'http://jack:5225' },
      downloads: { completedPath: downloadsPath },
      servers: [],
      peers: [],
    } as any)
  })

  test('leaves downloads off when the folder is missing', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.jsonc')
    await createDefaultAppConfig(path, { downloadsPath: join(dir, 'missing') })
    expect((await readConfig(path)).downloads).toBeUndefined()
  })

  test('leaves downloads off when the path is a file', async () => {
    const dir = await tempDir()
    const downloadsPath = join(dir, 'file')
    await Bun.write(downloadsPath, '')
    const path = join(dir, 'config.jsonc')
    await createDefaultAppConfig(path, { downloadsPath })
    expect((await readConfig(path)).downloads).toBeUndefined()
  })

  // Root may write anywhere, so the permission check only shows for other users.
  test.skipIf(process.getuid?.() === 0)('leaves downloads off when the folder is read-only', async () => {
    const dir = await tempDir()
    const downloadsPath = join(dir, 'ro')
    await mkdir(downloadsPath)
    await chmod(downloadsPath, 0o555)
    const path = join(dir, 'config.jsonc')
    await createDefaultAppConfig(path, { downloadsPath })
    await chmod(downloadsPath, 0o755)
    expect((await readConfig(path)).downloads).toBeUndefined()
  })

  test('a first start logs the new config at info, not as a warning', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.jsonc')
    const warn = spyOn(logger, 'warn')
    const info = spyOn(logger, 'info')
    try {
      await getAppConfig({ APP_CONFIG_PATH: path }, { downloadsPath: join(dir, 'missing') })
      expect(warn).not.toHaveBeenCalled()
      expect(info.mock.calls.map(call => call.at(-1))).toContain(`Created a default config at ${path}`)
    }
    finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  test('never touches an existing config file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.jsonc')
    await Bun.write(path, '{"version":2,"jack":{"internalUrl":"http://mine:5225"}}')
    expect(await createDefaultAppConfig(path, { downloadsPath: dir, internalUrl: 'http://other:5225' })).toBeNull()
    expect(await Bun.file(path).text()).toBe('{"version":2,"jack":{"internalUrl":"http://mine:5225"}}')
  })
})

describe('JACK_INTERNAL_URL', () => {
  test('seeds jack.internalUrl in a new config file only', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.jsonc')

    const created = await getAppConfig({ APP_CONFIG_PATH: path, JACK_INTERNAL_URL: '192.168.1.10:5225/' }, { downloadsPath: join(dir, 'missing') })
    expect(created.appConfig.jack.internalUrl).toBe('http://192.168.1.10:5225')
    expect((await readConfig(path)).jack.internalUrl).toBe('http://192.168.1.10:5225')

    const reloaded = await getAppConfig({ APP_CONFIG_PATH: path, JACK_INTERNAL_URL: 'http://changed:5225' })
    expect(reloaded.appConfig.jack.internalUrl).toBe('http://192.168.1.10:5225')
  })

  test('normalises the value and ignores one that isn\'t an http(s) URL', () => {
    expect(internalUrlFromEnv('https://jack.lan:5225')).toBe('https://jack.lan:5225')
    expect(internalUrlFromEnv('  ')).toBeUndefined()
    expect(internalUrlFromEnv('ftp://jack:21')).toBeUndefined()
    expect(internalUrlFromEnv('http://')).toBeUndefined()
  })
})
