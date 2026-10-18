import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { join } from 'node:path'

/** `ok` passed, `error` found a problem, `unknown` couldn't check. */
export type CheckStatus = 'ok' | 'error' | 'unknown'

export interface PathCheck {
  path: string
  status: CheckStatus
  message: string
}

/** A Radarr/Sonarr whose library jack shares: can jack see its folders and read its files? */
export interface SourceFolderReport {
  serverId: string
  name: string
  type: string
  /** The worst of the checks below, or `unknown` when jack couldn't ask the *arr. */
  status: CheckStatus
  /** Why the *arr couldn't be checked; null when it could. */
  message: string | null
  rootFolders: PathCheck[]
  sampleFiles: PathCheck[]
}

/** Does a Radarr/Sonarr jack downloads for see jack's completed folder at the same path? */
export interface DestinationFolderReport {
  serverId: string
  name: string
  type: string
  status: CheckStatus
  message: string
}

export interface CompletedFolderReport {
  path: string
  /** The worst of the checks below. */
  status: CheckStatus
  message: string
  exists: boolean
  writable: boolean | null
  /** Free space on the folder's filesystem; null when unknown. */
  freeBytes: number | null
  destinations: DestinationFolderReport[]
}

export interface FolderReport {
  checkedAt: string
  /** No check found a problem (checks that couldn't run don't count). */
  ok: boolean
  sources: SourceFolderReport[]
  /** Null when downloads are off. */
  completed: CompletedFolderReport | null
}

export interface FolderCheckDeps {
  servers: () => ArrServerConnector[]
  /** downloads.completedPath as stored now; null when downloads are off. */
  completedPath: () => string | null
  /** Per *arr request (default 10 s). */
  timeoutMs?: number
  /** Per file system call (default: timeoutMs), so a hung network mount can't hold the report. */
  fsTimeoutMs?: number
  /** For the library listing behind the sample files (default 30 s; a big library takes a while). */
  libraryTimeoutMs?: number
  now?: () => Date
}

// Files read per source: one per root folder, at most this many.
const SAMPLE_FILES = 2
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_LIBRARY_TIMEOUT_MS = 30_000
// Read one byte, to prove the file opens, not only that its name is visible.
const PROBE_READ_BYTES = 1

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('error'))
    return 'error'
  if (statuses.includes('unknown'))
    return 'unknown'
  return 'ok'
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Settle within `ms`, or reject; a hung network mount can't hold the report. */
async function within<T>(ms: number, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(reject, ms, Object.assign(new Error(`No answer within ${Math.round(ms / 1000)} seconds`), { code: 'ETIMEDOUT' }))
  })
  try {
    return await Promise.race([run, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

const label = (server: ArrServerConnector) => server.type === 'sonarr' ? 'Sonarr' : 'Radarr'

/**
 * Checks the folder mappings that break silently on Unraid: jack must see each
 * source's library at the path that *arr reports, and each destination must see
 * jack's completed folder at the same path as jack. The second is proved with a
 * test file: jack writes it, asks the *arr to list the folder, then removes it.
 */
export class FolderCheck {
  private readonly timeoutMs: number
  private readonly fsTimeoutMs: number
  private readonly libraryTimeoutMs: number
  private readonly now: () => Date

  constructor(private readonly deps: FolderCheckDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fsTimeoutMs = deps.fsTimeoutMs ?? this.timeoutMs
    this.libraryTimeoutMs = deps.libraryTimeoutMs ?? DEFAULT_LIBRARY_TIMEOUT_MS
    this.now = deps.now ?? (() => new Date())
  }

  async run(): Promise<FolderReport> {
    const servers = this.deps.servers()
    const completedPath = this.deps.completedPath()
    const [sources, completed] = await Promise.all([
      Promise.all(servers.filter(s => s.canSource).map(s => this.checkSource(s))),
      completedPath ? this.checkCompleted(completedPath, servers.filter(s => s.canDestination)) : Promise.resolve(null),
    ])
    const statuses = [...sources.map(s => s.status), ...(completed ? [completed.status] : [])]
    return { checkedAt: this.now().toISOString(), ok: !statuses.includes('error'), sources, completed }
  }

  private async checkSource(server: ArrServerConnector): Promise<SourceFolderReport> {
    const base = { serverId: server.id, name: server.name, type: server.type }
    if (!server.isInitialized) {
      const reason = server.initializationError ? `: ${server.initializationError}` : ''
      return { ...base, status: 'unknown', message: `jack isn't connected to ${server.name}${reason}`, rootFolders: [], sampleFiles: [] }
    }
    let roots: Array<{ path: string }>
    let samples: string[]
    try {
      ;[roots, samples] = await Promise.all([
        within(this.timeoutMs, server.rootFolders({ timeoutMs: this.timeoutMs })),
        within(this.libraryTimeoutMs, server.sampleFilePaths(SAMPLE_FILES, { timeoutMs: this.libraryTimeoutMs })),
      ])
    }
    catch (err) {
      return { ...base, status: 'unknown', message: `jack couldn't ask ${server.name} for its folders: ${messageOf(err)}`, rootFolders: [], sampleFiles: [] }
    }
    const rootFolders = await Promise.all(roots.map(root => this.checkRoot(server, root.path)))
    const sampleFiles = await Promise.all(samples.map(path => this.checkSample(server, path)))
    const status = worst([...rootFolders, ...sampleFiles].map(c => c.status))
    const message = rootFolders.length === 0 && sampleFiles.length === 0
      ? `${server.name} has no root folders or files yet, so there was nothing to check.`
      : null
    return { ...base, status, message, rootFolders, sampleFiles }
  }

  private async checkRoot(server: ArrServerConnector, path: string): Promise<PathCheck> {
    try {
      const stat = await within(this.fsTimeoutMs, fs.stat(path))
      if (!stat.isDirectory())
        return { path, status: 'error', message: `${path} exists in jack's container, but it isn't a folder.` }
      return { path, status: 'ok', message: `jack sees ${label(server)}'s folder ${path}.` }
    }
    catch (err) {
      const code = errorCode(err)
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return { path, status: 'error', message: `jack can't see ${path}. ${server.name} keeps its library there, but jack's container has no such folder. In the jack template, add a path with Container Path ${path}, pointing to the same host folder as in ${label(server)}'s template.` }
      if (code === 'EACCES' || code === 'EPERM')
        return { path, status: 'error', message: `jack isn't allowed to open ${path}. Check the folder's permissions for user 1000 (the jack container's user).` }
      return { path, status: 'unknown', message: `jack couldn't check ${path}: ${messageOf(err)}` }
    }
  }

  private async checkSample(server: ArrServerConnector, path: string): Promise<PathCheck> {
    try {
      await within(this.fsTimeoutMs, (async () => {
        const handle = await fs.open(path, constants.O_RDONLY)
        try {
          await handle.read(new Uint8Array(PROBE_READ_BYTES), 0, PROBE_READ_BYTES, 0)
        }
        finally {
          await handle.close()
        }
      })())
      return { path, status: 'ok', message: `jack can read ${path}.` }
    }
    catch (err) {
      const code = errorCode(err)
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return { path, status: 'error', message: `jack can't find ${path}, a file ${server.name} has. Friends who ask for it get "file missing". Map ${label(server)}'s library folder into the jack container at the same path.` }
      if (code === 'EACCES' || code === 'EPERM')
        return { path, status: 'error', message: `jack sees ${path} but isn't allowed to read it. Check the file's permissions for user 1000 (the jack container's user).` }
      return { path, status: 'unknown', message: `jack couldn't read ${path}: ${messageOf(err)}` }
    }
  }

  private async checkCompleted(path: string, destinations: ArrServerConnector[]): Promise<CompletedFolderReport> {
    const fail = (status: CheckStatus, message: string, exists: boolean, writable: boolean | null): CompletedFolderReport =>
      ({ path, status, message, exists, writable, freeBytes: null, destinations: [] })

    try {
      const stat = await within(this.fsTimeoutMs, fs.stat(path))
      if (!stat.isDirectory())
        return fail('error', `The completed folder ${path} exists in jack's container, but it isn't a folder.`, true, null)
    }
    catch (err) {
      const code = errorCode(err)
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return fail('error', `The completed folder ${path} doesn't exist in jack's container. Check the Downloads path in the jack template.`, false, null)
      return fail('unknown', `jack couldn't check the completed folder ${path}: ${messageOf(err)}`, false, null)
    }

    const freeBytes = await within(this.fsTimeoutMs, fs.statfs(path))
      .then(s => Number(s.bavail) * Number(s.bsize))
      .catch(() => null)

    // A plain name: an *arr's folder browser may leave out hidden files.
    const probeName = `jack-folder-check-${randomUUID()}.txt`
    const probePath = join(path, probeName)
    const write = fs.writeFile(probePath, 'jack folder check; safe to delete\n', { flag: 'wx' })
    try {
      await within(this.fsTimeoutMs, write)
    }
    catch (err) {
      // A write that timed out may still create the file later; remove it then.
      void write.then(() => fs.rm(probePath, { force: true })).catch(() => {})
      const code = errorCode(err)
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
        return { ...fail('error', `jack can't write to the completed folder ${path}. Check its permissions for user 1000 (the jack container's user), and that the template doesn't mount it read-only.`, true, false), freeBytes }
      if (code === 'ENOSPC')
        return { ...fail('error', `The disk with the completed folder ${path} is full.`, true, false), freeBytes }
      return { ...fail('unknown', `jack couldn't write a test file to ${path}: ${messageOf(err)}`, true, null), freeBytes }
    }

    let destinationReports: DestinationFolderReport[]
    try {
      destinationReports = await Promise.all(destinations.map(d => this.checkDestination(d, path, probeName)))
    }
    finally {
      await fs.rm(probePath, { force: true }).catch(() => {})
    }
    const status = worst(destinationReports.map(d => d.status))
    const message = status === 'error'
      ? 'jack can write here, but not every Radarr/Sonarr sees this folder at the same path.'
      : 'jack can write to the completed folder.'
    return { path, status, message, exists: true, writable: true, freeBytes, destinations: destinationReports }
  }

  private async checkDestination(server: ArrServerConnector, path: string, probeName: string): Promise<DestinationFolderReport> {
    const base = { serverId: server.id, name: server.name, type: server.type }
    if (!server.isInitialized)
      return { ...base, status: 'unknown', message: `jack isn't connected to ${server.name}, so it couldn't ask.` }
    let files: Array<{ name: string }>
    try {
      files = await within(this.timeoutMs, server.listFolderFiles(path, { timeoutMs: this.timeoutMs }))
    }
    catch (err) {
      return { ...base, status: 'unknown', message: `jack couldn't ask ${server.name} to list ${path}: ${messageOf(err)}` }
    }
    if (files.some(f => f.name === probeName))
      return { ...base, status: 'ok', message: `${server.name} sees jack's completed folder at ${path}.` }
    if (files.length > 0)
      return { ...base, status: 'error', message: `${server.name} has a folder at ${path}, but it's a different folder from jack's: it doesn't show the test file jack just wrote. In ${label(server)}'s template, map the same host folder as jack's Downloads path to ${path}.` }
    return { ...base, status: 'error', message: `${server.name} doesn't see jack's completed folder at ${path}, so it can't import what jack downloads. In ${label(server)}'s template, map the same host folder as jack's Downloads path to ${path}.` }
  }
}
