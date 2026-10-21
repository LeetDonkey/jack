import type { CompletedFolderReport, FolderReport, SourceFolderReport } from '~/types/tools'
import { describe, expect, test } from 'bun:test'
import { folderProblems, folderSummary, serverFolderResult } from './folder-check'

function source(overrides: Partial<SourceFolderReport> = {}): SourceFolderReport {
  return {
    serverId: 'radarr',
    name: 'Radarr',
    type: 'radarr',
    status: 'ok',
    message: null,
    rootFolders: [{ path: '/movies', status: 'ok', message: 'jack sees Radarr\'s folder /movies.' }],
    sampleFiles: [{ path: '/movies/a.mkv', status: 'ok', message: 'jack can read /movies/a.mkv.' }],
    ...overrides,
  }
}

function completed(overrides: Partial<CompletedFolderReport> = {}): CompletedFolderReport {
  return {
    path: '/data/jack',
    status: 'ok',
    message: 'jack can write to the completed folder.',
    exists: true,
    writable: true,
    freeBytes: 1024,
    destinations: [{ serverId: 'sonarr', name: 'Sonarr', type: 'sonarr', status: 'ok', message: 'Sonarr sees jack\'s completed folder at /data/jack.' }],
    ...overrides,
  }
}

function report(overrides: Partial<FolderReport> = {}): FolderReport {
  return { checkedAt: '2026-10-18T12:00:00.000Z', ok: true, sources: [source()], completed: completed(), ...overrides }
}

describe('folderSummary', () => {
  test('all good', () => {
    expect(folderSummary(report())).toEqual({ tone: 'ok', text: 'All folders line up.' })
  })

  test('leads with what a Radarr/Sonarr sees of the completed folder', () => {
    const missing = 'Sonarr doesn\'t see jack\'s completed folder at /data/jack, so it can\'t import what jack downloads.'
    const r = report({
      ok: false,
      sources: [source({ status: 'error', rootFolders: [{ path: '/movies', status: 'error', message: 'jack can\'t see /movies.' }] })],
      completed: completed({
        status: 'error',
        message: 'jack can write here, but not every Radarr/Sonarr sees this folder at the same path.',
        destinations: [{ serverId: 'sonarr', name: 'Sonarr', type: 'sonarr', status: 'error', message: missing }],
      }),
    })
    expect(folderSummary(r)).toEqual({ tone: 'error', text: missing })
    expect(folderProblems(r).map(p => p.message)).toEqual([missing, 'jack can\'t see /movies.'])
  })

  test('uses the completed folder\'s own message when no Radarr/Sonarr was asked', () => {
    const r = report({ ok: false, completed: completed({ status: 'error', exists: false, writable: null, message: 'The completed folder /data/jack doesn\'t exist in jack\'s container.', destinations: [] }) })
    expect(folderSummary(r).text).toBe('The completed folder /data/jack doesn\'t exist in jack\'s container.')
  })

  test('a check that couldn\'t run is a warning, after any error', () => {
    const r = report({ sources: [source({ status: 'unknown', message: 'jack isn\'t connected to Radarr', rootFolders: [], sampleFiles: [] })] })
    expect(folderSummary(r)).toEqual({ tone: 'warning', text: 'Some checks couldn\'t run. jack isn\'t connected to Radarr' })
  })

  test('nothing to check', () => {
    expect(folderSummary(report({ sources: [], completed: null })).tone).toBe('warning')
  })

  test('with no Radarr/Sonarr, only says jack can write to the completed folder', () => {
    expect(folderSummary(report({ sources: [], completed: completed({ destinations: [] }) }))).toEqual({
      tone: 'warning',
      text: 'jack can write to /data/jack. Connect a Radarr or Sonarr to check that it sees the same folder.',
    })
  })

  test('with no Radarr/Sonarr, a completed folder jack can\'t write to is still an error', () => {
    const r = report({ ok: false, sources: [], completed: completed({ status: 'error', writable: false, message: 'jack can\'t write to /data/jack.', destinations: [] }) })
    expect(folderSummary(r)).toEqual({ tone: 'error', text: 'jack can\'t write to /data/jack.' })
  })

  test('a library that lines up is enough for the all-clear', () => {
    expect(folderSummary(report({ completed: completed({ destinations: [] }) }))).toEqual({ tone: 'ok', text: 'All folders line up.' })
  })
})

describe('serverFolderResult', () => {
  test('a server the report didn\'t cover has no result', () => {
    expect(serverFolderResult(report(), 'other')).toBeNull()
  })

  test('passes for a server whose checks passed', () => {
    expect(serverFolderResult(report(), 'radarr')).toEqual({ status: 'ok', message: 'Folders line up.' })
    expect(serverFolderResult(report(), 'sonarr')).toEqual({ status: 'ok', message: 'Folders line up.' })
  })

  test('names the first problem of that server only', () => {
    const r = report({ sources: [source({ status: 'error', sampleFiles: [{ path: '/movies/a.mkv', status: 'error', message: 'jack can\'t find /movies/a.mkv.' }] })] })
    expect(serverFolderResult(r, 'radarr')).toMatchObject({ status: 'error', message: 'jack can\'t find /movies/a.mkv.' })
    expect(serverFolderResult(r, 'sonarr')?.status).toBe('ok')
  })
})
