import { Database } from 'bun:sqlite'
import { describe, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { ConflictError } from '../lib/errors/ConflictError'
import { NotFoundError } from '../lib/errors/NotFoundError'
import { getManagementApp } from '../management-app'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

const HEADERS = { 'X-Management-Key': 'secret' }
const MISSING_ID = 999

function setup() {
  const sqlite = new Database(':memory:')
  const db = drizzle({ client: sqlite, schema })
  runMigrations(db)
  const repository = new DownloadsRepository(db)
  const row = repository.create({
    torrentFilename: 'one.torrent',
    peerId: 'peer-1',
    peerName: 'Peer',
    itemId: 'movie:1',
    filename: 'one.mkv',
    destPath: '/tmp/one.mkv',
    partPath: '/tmp/one.mkv.part',
    releaseSize: 10,
    release: { id: 'r', title: 'one', filename: 'one.mkv', category: 2000, size: 10 } as any,
  })
  const cancel = mock(async (id: number) => repository.get(id)!)
  const retryTransfer = mock((id: number) => repository.get(id)!)
  const retryNow = mock((id: number) => {
    if (id === MISSING_ID)
      throw new NotFoundError(`Download ${id} not found`)
    if (id !== row.id)
      throw new ConflictError(`Download ${id} is not waiting to retry`)
    return repository.get(id)!
  })
  const deleteDownload = mock(async (id: number) => repository.delete(id))
  const retryImport = mock(async (id: number) => repository.get(id)!)
  const downloadsService = { cancel, retry: retryTransfer, retryNow, delete: deleteDownload } as any
  const app = getManagementApp({
    environment: 'test',
    managementKey: 'secret',
    connectors: { peers: [], servers: [] },
    downloadsRepository: repository,
    downloadsService,
    importWatcher: { retry: retryImport } as any,
  })
  return { app, cancel, retryTransfer, retryNow, retryImport, deleteDownload, repository, row, sqlite }
}

describe('management download actions', () => {
  test('POST /downloads/:id/cancel targets the numeric record id', async () => {
    const { app, cancel, row, sqlite } = setup()

    const response = await app.request(`/downloads/${row.id}/cancel`, { method: 'POST', headers: HEADERS })

    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith(row.id)
    sqlite.close()
  })

  test('rejects a non-numeric download id', async () => {
    const { app, cancel, sqlite } = setup()

    const response = await app.request('/downloads/not-a-number/cancel', { method: 'POST', headers: HEADERS })

    expect(response.status).toBe(400)
    expect(cancel).not.toHaveBeenCalled()
    sqlite.close()
  })

  test('POST /downloads/:id/retry dispatches from the persisted last failed operation', async () => {
    const { app, retryTransfer, retryImport, repository, row, sqlite } = setup()
    repository.markFailed(row.id, 'transfer failed', 'transfer')

    const transferResponse = await app.request(`/downloads/${row.id}/retry`, { method: 'POST', headers: HEADERS })
    expect(transferResponse.status).toBe(200)
    expect(retryTransfer).toHaveBeenCalledWith(row.id)

    repository.markImportQueued(row.id)
    repository.markFailed(row.id, 'import failed', 'import')
    // Retry selection is driven by the persisted failed operation, not the display status.
    sqlite.query('UPDATE downloads SET status = ? WHERE id = ?').run('imported', row.id)
    const importResponse = await app.request(`/downloads/${row.id}/retry`, { method: 'POST', headers: HEADERS })
    expect(importResponse.status).toBe(200)
    expect(retryImport).toHaveBeenCalledWith(row.id)
    sqlite.close()
  })

  test('POST /downloads/:id/retry-now ends the wait, and answers 409 for a row that isn\'t waiting', async () => {
    const { app, retryNow, row, sqlite } = setup()

    const response = await app.request(`/downloads/${row.id}/retry-now`, { method: 'POST', headers: HEADERS })
    expect(response.status).toBe(200)
    expect(retryNow).toHaveBeenCalledWith(row.id)
    expect((await response.json() as { download: { id: number } }).download.id).toBe(row.id)

    const conflict = await app.request(`/downloads/${row.id + 1}/retry-now`, { method: 'POST', headers: HEADERS })
    expect(conflict.status).toBe(409)
    sqlite.close()
  })

  // jack-ui tells the two apart: a gone row is stale, a missing route means jack
  // is older than jack-ui.
  test('a gone download answers 404 with NOT_FOUND, and a route jack lacks 404 without it', async () => {
    const { app, sqlite } = setup()

    const gone = await app.request(`/downloads/${MISSING_ID}/retry-now`, { method: 'POST', headers: HEADERS })
    expect(gone.status).toBe(404)
    expect((await gone.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')

    const missingRoute = await app.request('/downloads/1/no-such-action', { method: 'POST', headers: HEADERS })
    expect(missingRoute.status).toBe(404)
    expect(await missingRoute.text()).not.toContain('NOT_FOUND')
    sqlite.close()
  })

  test('DELETE /downloads/:id delegates deletion by record id', async () => {
    const { app, deleteDownload, row, sqlite } = setup()

    const response = await app.request(`/downloads/${row.id}`, { method: 'DELETE', headers: HEADERS })

    expect(response.status).toBe(200)
    expect(deleteDownload).toHaveBeenCalledWith(row.id)
    sqlite.close()
  })
})
