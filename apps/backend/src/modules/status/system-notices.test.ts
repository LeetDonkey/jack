import type { ChangedDefault, RawConfigBlocks } from './system-notices'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../database/connection'
import { JackMeta } from '../../database/jack-meta'
import { getManagementApp } from '../../management-app'
import { changedDefaults, DEFAULTS_NOTICE_ID, SystemNotices } from './system-notices'

const ALL_CHANGED: ChangedDefault[] = [
  { setting: 'discovery.introduce', was: true, now: false },
  { setting: 'security.banEnabled', was: false, now: true },
  { setting: 'security.lanOnlyArrApis', was: false, now: true },
  { setting: 'security.publicOpenApi', was: true, now: false },
]

describe('changedDefaults', () => {
  test('lists every setting still on its default, with the old and the new behaviour', () => {
    expect(changedDefaults(null)).toEqual(ALL_CHANGED)
    expect(changedDefaults({ discovery: { publicName: 'Alice', discoverable: true }, security: { maxFailures: 5 } })).toEqual(ALL_CHANGED)
  })

  test('a stored value is the user\'s choice, whatever it is', () => {
    expect(changedDefaults({ discovery: { introduce: false }, security: { banEnabled: true, publicOpenApi: true } }).map(c => c.setting))
      .toEqual(['security.lanOnlyArrApis'])
    expect(changedDefaults({ discovery: { introduce: true }, security: { banEnabled: false, lanOnlyArrApis: false, publicOpenApi: false } })).toEqual([])
  })
})

describe('SystemNotices', () => {
  function notices(raw: RawConfigBlocks | null = null, sqlite = new Database(':memory:')) {
    const config = { raw }
    return { service: new SystemNotices(new JackMeta(sqlite), () => config.raw), sqlite, config }
  }

  test('an install from before the update gets the notice; a new one never does', () => {
    const upgraded = notices()
    upgraded.service.init(true)
    expect(upgraded.service.list()).toEqual([{ id: DEFAULTS_NOTICE_ID, kind: 'defaultsChanged', changed: ALL_CHANGED }])

    const fresh = notices()
    fresh.service.init(false)
    expect(fresh.service.list()).toEqual([])
    // Its later boots have migrations, but the marker says it was new.
    const rebooted = new SystemNotices(new JackMeta(fresh.sqlite), () => null)
    rebooted.init(true)
    expect(rebooted.list()).toEqual([])
    expect(() => rebooted.dismiss(DEFAULTS_NOTICE_ID)).toThrow('No notice')
  })

  test('drops settings the user stores, and the notice once none are left', () => {
    const { service, config } = notices()
    service.init(true)
    config.raw = { discovery: { introduce: true }, security: { banEnabled: true } }
    expect(service.list()[0]!.changed.map(c => c.setting)).toEqual(['security.lanOnlyArrApis', 'security.publicOpenApi'])
    config.raw = { discovery: { introduce: true }, security: { banEnabled: true, lanOnlyArrApis: true, publicOpenApi: false } }
    expect(service.list()).toEqual([])
    // null in a block (as a PATCH would never store it) counts as not stored.
    config.raw = { discovery: { introduce: null }, security: { banEnabled: true, lanOnlyArrApis: true, publicOpenApi: false } }
    expect(service.list()[0]!.changed).toEqual(ALL_CHANGED.slice(0, 1))
  })

  test('a dismissed notice stays gone after a restart, and tells subscribers once', () => {
    const { service, sqlite } = notices()
    service.init(true)
    let told = 0
    service.subscribe(() => told++)
    service.dismiss(DEFAULTS_NOTICE_ID)
    service.dismiss(DEFAULTS_NOTICE_ID)
    expect(told).toBe(1)
    expect(service.list()).toEqual([])

    const restarted = new SystemNotices(new JackMeta(sqlite), () => null)
    restarted.init(true)
    expect(restarted.list()).toEqual([])
    expect(() => restarted.dismiss('nope')).toThrow('No notice')
  })
})

describe('openDatabase', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true })
  })

  test('tells a database from an earlier boot from a new one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jack-notices-'))
    dirs.push(dir)
    const first = await openDatabase({ appConfigPath: join(dir, 'config.jsonc') })
    expect(first.preexisting).toBe(false)
    first.close()
    const second = await openDatabase({ appConfigPath: join(dir, 'config.jsonc') })
    expect(second.preexisting).toBe(true)
    second.close()
  })
})

describe('POST /system/notices/:id/dismiss', () => {
  const KEY = { 'X-Management-Key': 'k' }

  test('dismisses the notice, which leaves the overview', async () => {
    const service = new SystemNotices(new JackMeta(new Database(':memory:')), () => null)
    service.init(true)
    const app = getManagementApp({
      environment: 'test',
      managementKey: 'k',
      connectors: { servers: [], peers: [] },
      system: () => ({ bootedAt: '2026-10-19T00:00:00.000Z', restartPending: [], notices: service.list() }),
      notices: service,
    })
    const overview = async () => (await (await app.request('/overview', { headers: KEY })).json() as { system: { notices: unknown[] } }).system
    expect((await overview()).notices).toEqual([{ id: DEFAULTS_NOTICE_ID, kind: 'defaultsChanged', changed: ALL_CHANGED }])

    const res = await app.request(`/system/notices/${DEFAULTS_NOTICE_ID}/dismiss`, { method: 'POST', headers: KEY })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect((await overview()).notices).toEqual([])
    expect((await app.request(`/system/notices/${DEFAULTS_NOTICE_ID}/dismiss`, { method: 'POST', headers: KEY })).status).toBe(204)
    expect((await app.request('/system/notices/other/dismiss', { method: 'POST', headers: KEY })).status).toBe(404)
    expect((await app.request(`/system/notices/${DEFAULTS_NOTICE_ID}/dismiss`, { method: 'POST' })).status).toBe(401)
  })

  test('answers 404 without a notice service', async () => {
    const app = getManagementApp({ environment: 'test', managementKey: 'k', connectors: { servers: [], peers: [] } })
    expect((await app.request('/system/notices/x/dismiss', { method: 'POST', headers: KEY })).status).toBe(404)
    expect(((await (await app.request('/overview', { headers: KEY })).json()) as { system: { notices: unknown[] } }).system.notices).toEqual([])
  })
})
