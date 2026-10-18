import type { AppConfig } from '../../lib/config'
import type { ConnectorManager } from '../../lib/servers'
import type { ManualImportTarget } from '../../lib/servers/arr/base'
import type { PeerDownloadProgressEvent } from '../../lib/servers/peer'
import type { TransfersService } from '../transfers/transfers.service'
import type { DownloadOperationCoordinator } from './download-operation-coordinator'
import type { DownloadPhase, DownloadPhaseState } from './download-state'
import type { DownloadRecord, DownloadsRepository } from './downloads.repository'
import { basename, join, resolve } from 'node:path'
import { ConflictError } from '../../lib/errors/ConflictError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { retry } from '../../lib/retry'
import { Semaphore } from '../../lib/semaphore'
import { logger } from '../../logger'
import { unlinkDownloadArtifact } from './artifact-cleanup'
import { coordinatorFor } from './download-operation-coordinator'
import { DownloadSources } from './download-sources'
import { DOWNLOAD_CANCELLED_MESSAGE, isCancelledByUser } from './download-state'
import { verifyAndRepair } from './piece-verifier'
import { downloadRetryAfterMs, isTransientDownloadError } from './retry-policy'

// retryWindowMs is optional so a config built without the schema keeps only the
// maxDownloadAttempts limit.
type DownloadsServiceConfig = Omit<NonNullable<AppConfig['downloads']>, 'retryWindowMs'> & { retryWindowMs?: number }

// HH:MM in the server's time zone, for the "waiting to retry" note on a row.
const retryTimeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const RETRY_WAIT_PREFIX = 'Waiting to retry at'
// How long a finished download waits for a peer that is still hashing the file.
const PIECES_WAIT_MS = 10 * 60_000

// Characters disallowed in the synthetic qB torrent filename (keep word chars, dot, dash).
const UNSAFE_FILENAME_CHARS = /[^\w.-]/g

/**
 * Outcome of a qB add:
 * - 'started' — a new download row was created and is running.
 * - 'duplicate' — a download for the same destination is already in flight; the
 *   add is a no-op but still a success (the release is being fetched).
 * - 'failed' — no row could be created (unknown peer or an unsafe peer filename).
 */
export type StartQbDownloadResult = 'started' | 'duplicate' | 'failed'

// The abort reason of a cancel, so the row gets DOWNLOAD_CANCELLED_MESSAGE whatever
// error the aborted transfer happened to throw.
class DownloadCancelledError extends Error {
  constructor() {
    super(DOWNLOAD_CANCELLED_MESSAGE)
    this.name = 'DownloadCancelledError'
  }
}

function failureMessage(err: unknown, signal: AbortSignal): string {
  if (signal.aborted && signal.reason instanceof DownloadCancelledError)
    return DOWNLOAD_CANCELLED_MESSAGE
  return err instanceof Error ? err.message : String(err)
}

// createDownload's internal outcome: a record to run, a benign duplicate, or no peer.
type CreateDownloadOutcome
  = | { kind: 'created', record: DownloadRecord }
    | { kind: 'duplicate' }
    | { kind: 'no-peer' }

export class DownloadsService {
  private readonly semaphore: Semaphore
  private maxConcurrent: number
  // Dest paths with a download in flight — guards two concurrent live drops that
  // resolve to the same destination (no duplicate rows / writers).
  private readonly active = new Set<string>()
  private readonly transfers = new Map<number, { controller: AbortController, task: Promise<void> }>()
  private readonly coordinator?: DownloadOperationCoordinator
  private readonly failedListeners = new Set<(record: DownloadRecord, error: string) => void>()
  private readonly phases = new Map<number, DownloadPhaseState>()
  private readonly phaseSubscribers = new Set<() => void>()
  private readonly now: () => number

  constructor(
    private readonly config: DownloadsServiceConfig,
    // Only the live `peers` getter is used; accept the structural shape so a real
    // ConnectorManager (live) or a test stub both satisfy it.
    private readonly connectorManager: { peers: ConnectorManager['peers'] },
    private readonly downloadsRepository?: DownloadsRepository,
    coordinator?: DownloadOperationCoordinator,
    // Live speed tracking and the shared download rate limit. Optional so the
    // service still works standalone (tests, no management API).
    private readonly transfersService?: Pick<TransfersService, 'monitor' | 'downloadLimiter' | 'ledger'>,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.semaphore = new Semaphore(config.maxConcurrentDownloads)
    this.maxConcurrent = config.maxConcurrentDownloads
    this.coordinator = coordinator ?? (downloadsRepository ? coordinatorFor(downloadsRepository) : undefined)
  }

  /** Called when a download fails for good (not when it is cancelled). */
  onDownloadFailed(listener: (record: DownloadRecord, error: string) => void): () => void {
    this.failedListeners.add(listener)
    return () => this.failedListeners.delete(listener)
  }

  get maxConcurrentDownloads(): number {
    return this.maxConcurrent
  }

  /**
   * Pause or resume new downloads. While paused no download takes a slot, so
   * new and retrying ones stay `queued`; running transfers finish.
   */
  setPaused(paused: boolean): void {
    this.semaphore.setPaused(paused)
  }

  get isPaused(): boolean {
    return this.semaphore.isPaused
  }

  /** The phase of a download this process is running, or null when it runs none for that id. */
  phaseOf(id: number): DownloadPhaseState | null {
    const state = this.phases.get(id)
    return state ? { ...state } : null
  }

  /** Called whenever a download changes phase (queued, transferring, waiting to retry, done). */
  subscribe(subscriber: () => void): () => void {
    this.phaseSubscribers.add(subscriber)
    return () => this.phaseSubscribers.delete(subscriber)
  }

  private setPhase(id: number, phase: DownloadPhase | null, retryAt: string | null = null): void {
    const current = this.phases.get(id)
    if (phase === null) {
      if (!current)
        return
      this.phases.delete(id)
    }
    else {
      if (current?.phase === phase && current.retryAt === retryAt)
        return
      this.phases.set(id, { phase, retryAt })
    }
    for (const subscriber of this.phaseSubscribers) {
      try {
        subscriber()
      }
      catch {
        // Observers must not break a running download.
      }
    }
  }

  /** Change the concurrency limit without a restart. Running transfers are never interrupted. */
  setMaxConcurrentDownloads(max: number): void {
    if (max === this.maxConcurrent)
      return
    this.semaphore.setPermits(max)
    this.maxConcurrent = max
  }

  private get peers() {
    return this.connectorManager.peers
  }

  private requireRepository(): DownloadsRepository {
    if (!this.downloadsRepository)
      throw new ConflictError('Download management is unavailable')
    return this.downloadsRepository
  }

  /**
   * Shared creation core for the qB add path. Returns the created record, a
   * benign duplicate (a download for the same destination is already active),
   * or no-peer when the peer is unknown. Throws on an unsafe filename.
   */
  private async createDownload(input: {
    peerId: string
    itemId: string
    torrentFilename: string
    qbCategory?: string | null
    qbSourceServer?: string | null
    sourceServerId?: string | null
    importMode?: 'jack_manual' | null
    importTarget?: ManualImportTarget | null
  }): Promise<CreateDownloadOutcome> {
    const { peerId, itemId, torrentFilename } = input
    const peer = this.peers.find(p => p.id === peerId)
    if (!peer) {
      logger.error({ torrentFilename, peerId }, 'Peer not found')
      return { kind: 'no-peer' }
    }

    const release = await peer.getRelease(itemId)

    // `release.filename` is peer-controlled and only validated as a string.
    // Force it to a plain basename inside `completedPath` so a value like
    // `../../evil.mkv` or an absolute path cannot escape the directory.
    const safeName = basename(release.filename)
    const isSafeName = safeName.length > 0 && safeName !== '.' && safeName !== '..'
      && !safeName.includes('/') && !safeName.includes('\\')
      && release.filename === safeName
    if (!isSafeName)
      throw new Error(`Unsafe release filename from peer: ${release.filename}`)

    const destPath = join(this.config.completedPath, safeName)
    const partPath = `${destPath}.part`

    if (this.active.has(destPath) || this.coordinator?.isPathDeleting(resolve(destPath))) {
      logger.debug({ torrentFilename, destPath }, 'A download for this destination is already active; skipping duplicate')
      return { kind: 'duplicate' }
    }

    const created = this.downloadsRepository?.create({
      torrentFilename,
      peerId,
      peerName: peer.name ?? peer.url,
      itemId,
      filename: safeName,
      destPath,
      partPath,
      releaseSize: release.size,
      release,
      qbCategory: input.qbCategory ?? null,
      qbSourceServer: input.qbSourceServer ?? null,
      sourceServerId: input.sourceServerId ?? null,
      importMode: input.importMode ?? null,
      importTarget: input.importTarget ?? null,
    })

    return {
      kind: 'created',
      record: created ?? {
        id: -1,
        torrentFilename,
        peerId,
        peerName: peer.name ?? peer.url,
        itemId,
        filename: safeName,
        destPath,
        partPath,
        releaseSize: release.size,
        release,
        expectedBytes: null,
        expectedBytesSource: null,
        expectedBytesMismatch: false,
        downloadedBytes: 0,
        attempts: 0,
        status: 'downloading',
        startedAt: '',
        updatedAt: '',
        completedAt: null,
        error: null,
        lastOperation: 'transfer',
        operationFailed: false,
        qbCategory: input.qbCategory ?? null,
        qbSourceServer: input.qbSourceServer ?? null,
        sourceServerId: input.sourceServerId ?? null,
        importMode: input.importMode ?? null,
        importTarget: input.importTarget ?? null,
        manualImportCommandId: null,
      },
    }
  }

  /**
   * qB `/api/v2/torrents/add` entrypoint: create the row and drive the download
   * in the background (the HTTP handler returns immediately).
   */
  async startQbDownload(input: {
    peerId: string
    itemId: string
    qbCategory: string
    qbSourceServer: string
    sourceServerId: string
  }): Promise<StartQbDownloadResult> {
    // qB-added downloads have no on-disk stub, but createDownload + the row still
    // need a stable filename.
    const torrentFilename = `qb-${input.peerId}-${input.itemId}.torrent`.replace(UNSAFE_FILENAME_CHARS, '_')
    let outcome: CreateDownloadOutcome
    try {
      outcome = await this.createDownload({ ...input, torrentFilename })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ peerId: input.peerId, itemId: input.itemId, error: message }, 'Failed to create qB download')
      return 'failed'
    }
    if (outcome.kind === 'no-peer')
      return 'failed'
    // A duplicate is already in flight: no new row, but a success — don't make *arr retry.
    if (outcome.kind === 'duplicate')
      return 'duplicate'
    void this.enqueue(outcome.record).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ itemId: input.itemId, error: message }, 'qB download failed')
    })
    return 'started'
  }

  /**
   * Catalog direct-download entrypoint: create a jack_manual row bound to a
   * destination *arr + import target, then drive the download in the background.
   * Import is pushed later by the ImportWatcher.
   */
  async startDirectDownload(input: {
    peerId: string
    itemId: string
    destinationServerName: string
    destinationServerId: string
    importTarget: ManualImportTarget
  }): Promise<StartQbDownloadResult> {
    const torrentFilename = `direct-${input.peerId}-${input.itemId}.torrent`.replace(UNSAFE_FILENAME_CHARS, '_')
    let outcome: CreateDownloadOutcome
    try {
      outcome = await this.createDownload({
        peerId: input.peerId,
        itemId: input.itemId,
        torrentFilename,
        qbSourceServer: input.destinationServerName,
        sourceServerId: input.destinationServerId,
        importMode: 'jack_manual',
        importTarget: input.importTarget,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ peerId: input.peerId, itemId: input.itemId, error: message }, 'Failed to create direct download')
      return 'failed'
    }
    if (outcome.kind === 'no-peer')
      return 'failed'
    if (outcome.kind === 'duplicate')
      return 'duplicate'
    void this.enqueue(outcome.record).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ itemId: input.itemId, error: message }, 'Direct download failed')
    })
    return 'started'
  }

  /** Re-drive stale `downloading` rows from a prior run, resuming from their .part files. */
  async resumeStaleDownloads(): Promise<number> {
    const repo = this.downloadsRepository
    if (!repo)
      return 0
    // Dedupe by destPath: a prior run could leave more than one stale row for the
    // same destination (they share the same .part), but only one can be resumed.
    // Re-driving two would make the second silently early-return in runDownload
    // and stay stuck in `downloading`, so mark the superseded ones failed instead.
    const seen = new Set<string>()
    const resumable: DownloadRecord[] = []
    for (const record of repo.listStaleDownloads()) {
      if (seen.has(record.destPath)) {
        repo.markFailed(record.id, 'superseded by another resumable download for the same destination')
        continue
      }
      seen.add(record.destPath)
      resumable.push(record)
    }
    for (const record of resumable) {
      // Fire-and-forget: the semaphore caps concurrency.
      void this.enqueue(record).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ torrentFilename: record.torrentFilename, error: message }, 'Failed to resume stale download')
      })
    }
    if (resumable.length > 0)
      logger.info({ downloads: resumable.length }, 'Re-enqueued interrupted downloads')
    return resumable.length
  }

  private enqueue(record: DownloadRecord): Promise<void> {
    const controller = new AbortController()
    const task = this.runDownload(record, controller)
    this.transfers.set(record.id, { controller, task })
    void task.finally(() => {
      if (this.transfers.get(record.id)?.task === task)
        this.transfers.delete(record.id)
    }).catch(() => {})
    return task
  }

  async cancel(id: number): Promise<DownloadRecord> {
    const repo = this.requireRepository()
    const record = repo.get(id)
    if (!record)
      throw new NotFoundError(`Download ${id} not found`)
    if (isCancelledByUser(record))
      return record
    if (record.status !== 'downloading')
      throw new ConflictError(`Download ${id} is not active`)
    const transfer = this.transfers.get(id)
    if (!transfer)
      throw new ConflictError(`Download ${id} is not active in this process`)
    transfer.controller.abort(new DownloadCancelledError())
    await transfer.task
    return repo.get(id) ?? record
  }

  retry(id: number): DownloadRecord {
    const repo = this.requireRepository()
    const record = repo.get(id)
    if (!record)
      throw new NotFoundError(`Download ${id} not found`)
    if (!record.operationFailed || record.lastOperation !== 'transfer')
      throw new ConflictError(`Download ${id} has no failed transfer to retry`)
    if (this.coordinator?.isPathDeleting(resolve(record.destPath)))
      throw new ConflictError(`Download ${id} is being deleted`)
    if (this.transfers.has(id) || this.active.has(record.destPath))
      throw new ConflictError(`Download ${id} is already active`)
    repo.markTransferStarted(id)
    void this.enqueue(record).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ id, error: message }, 'Retried download failed')
    })
    return repo.get(id) ?? record
  }

  async delete(id: number): Promise<void> {
    const repo = this.requireRepository()
    const record = repo.get(id)
    if (!record)
      throw new NotFoundError(`Download ${id} not found`)
    const paths = [resolve(record.partPath), resolve(record.destPath)]
    const operation = async () => {
      const current = repo.get(id)
      if (!current)
        throw new NotFoundError(`Download ${id} not found`)
      if (current.status === 'downloading')
        await this.cancel(id)

      // unlinkDownloadArtifact re-reads ownership immediately before each unlink. A
      // sibling that began before the path reservation was installed must keep the
      // shared file.
      for (const artifact of [record.partPath, record.destPath])
        await unlinkDownloadArtifact(repo, id, artifact, this.config.completedPath)
      repo.delete(id)
    }
    if (this.coordinator)
      await this.coordinator.runDelete(id, paths, operation)
    else
      await operation()
  }

  private async runDownload(record: DownloadRecord, controller: AbortController): Promise<void> {
    if (this.active.has(record.destPath))
      return
    this.active.add(record.destPath)
    this.setPhase(record.id, 'queued')
    try {
      await this.downloadWithRetry(record, controller.signal)
    }
    catch (err) {
      this.downloadsRepository?.markFailed(record.id, failureMessage(err, controller.signal), 'transfer')
    }
    finally {
      this.active.delete(record.destPath)
      this.setPhase(record.id, null)
    }
  }

  /**
   * Check the finished .part against the peers' piece hashes and repair any
   * piece that doesn't match. A peer without hashes (an older jack) leaves the
   * download unverified, as before; the size check still applies.
   */
  private async verifyPart(record: DownloadRecord, sources: DownloadSources, signal: AbortSignal): Promise<void> {
    const list = await sources.pieceList(PIECES_WAIT_MS)
    if (!list) {
      logger.info({ filename: record.filename }, 'Download not verified: no peer has piece hashes for it')
      return
    }
    signal.throwIfAborted()
    const result = await verifyAndRepair(record.partPath, list, sources.pieceSources(signal))
    logger.info({ filename: record.filename, pieces: result.pieces, repaired: result.repaired }, result.repaired > 0
      ? 'Download verified after repairing pieces'
      : 'Download verified against the peer\'s piece hashes')
  }

  private async downloadWithRetry(record: DownloadRecord, signal: AbortSignal): Promise<void> {
    const repo = this.downloadsRepository
    const peer = this.peers.find(p => p.id === record.peerId)
    if (!peer) {
      repo?.markFailed(record.id, `Peer ${record.peerId} not found`)
      logger.error({ torrentFilename: record.torrentFilename, peerId: record.peerId }, 'Cannot run download: peer not found')
      return
    }

    const onProgress = async (event: PeerDownloadProgressEvent) => {
      if (event.type === 'headers') {
        repo?.setExpectedBytes(record.id, event.expectedBytes, event.expectedBytesSource, event.expectedBytesMismatch)
        return
      }
      if (event.type === 'progress') {
        repo?.updateProgress(record.id, event.downloadedBytes)
        return
      }
      if (event.type === 'restart') {
        repo?.markResumeReset(record.id)
        return
      }
      // event.type === 'completed': the transfer finished. Record the final byte
      // count; the status flips to import_queued once downloadFile resolves below.
      repo?.updateProgress(record.id, event.downloadedBytes)
    }

    const partBytes = async () => {
      const part = Bun.file(record.partPath)
      return await part.exists() ? part.size : 0
    }

    // Start of the retry window: the first attempt, then the last byte received.
    let lastProgressAt: number | undefined
    const retryWindowMs = this.config.retryWindowMs ?? 0
    // The grabbed peer, plus peers with a byte-identical file once one is needed.
    const sources = new DownloadSources({ peer, itemId: record.itemId }, { ...record.release, size: record.releaseSize }, () => this.peers)

    try {
      // Each attempt takes a download slot and gives it back before the backoff,
      // so a peer that is down doesn't block downloads from the others. A retry
      // rejoins the head of the queue, so it doesn't wait behind fresh downloads.
      await retry((attempt) => {
        this.setPhase(record.id, 'queued')
        return this.semaphore.run(async () => {
          this.setPhase(record.id, 'transferring')
          lastProgressAt ??= this.now()
          // Clear the "waiting to retry" note now that the next attempt is running.
          if (repo?.get(record.id)?.error?.startsWith(RETRY_WAIT_PREFIX))
            repo.setError(record.id, null)
          // After a failed attempt, continue from another peer with the same file if there is one.
          const source = attempt > 1 ? await sources.advance() : sources.current
          const sourceName = source.peer.name ?? source.peer.url
          // A transient failure that still grew the .part resumes right away and
          // doesn't use up a retry attempt. Otherwise a link that drops every GiB
          // could never finish a file larger than maxDownloadAttempts GiB. Only
          // attempts that make no progress count toward the limit.
          while (true) {
            signal.throwIfAborted()
            repo?.incrementAttempts(record.id)
            const bytesBefore = await partBytes()
            const transfer = this.transfersService?.monitor.start({
              direction: 'download',
              peer: sourceName,
              filename: record.filename,
              totalBytes: record.releaseSize ?? null,
              offsetBytes: bytesBefore,
              party: `peer:${source.peer.id}`,
              downloadId: record.id > 0 ? record.id : undefined,
            })
            try {
              await source.peer.downloadFile(source.itemId, record.destPath, {
                beforeFinalize: () => this.verifyPart(record, sources, signal),
                torrentFilename: record.torrentFilename,
                partPath: record.partPath,
                releaseSize: record.releaseSize,
                idleTimeoutMs: this.config.idleTimeoutMs,
                onProgress: async (event) => {
                  if (event.type === 'headers')
                    transfer?.setTotalBytes(event.expectedBytes)
                  else if (event.type === 'restart')
                    transfer?.add(-event.discardedBytes)
                  await onProgress(event)
                },
                onChunk: async (bytes) => {
                  lastProgressAt = this.now()
                  transfer?.add(bytes)
                  this.transfersService?.ledger?.add('in', `peer:${source.peer.id}`, sourceName, bytes)
                  await this.transfersService?.downloadLimiter.take(bytes, signal)
                },
                signal,
              })
              return
            }
            catch (err) {
              if (signal.aborted || !isTransientDownloadError(err) || await partBytes() <= bytesBefore)
                throw err
              lastProgressAt = this.now()
              const message = err instanceof Error ? err.message : String(err)
              logger.warn({ torrentFilename: record.torrentFilename, error: message }, 'Peer download interrupted after progress; resuming')
            }
            finally {
              transfer?.end()
            }
          }
        }, signal, { front: attempt > 1 })
      }, {
        maxAttempts: this.config.maxDownloadAttempts,
        keepRetrying: () => lastProgressAt != null && this.now() - lastProgressAt < retryWindowMs,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        isRetryable: isTransientDownloadError,
        retryAfterMs: downloadRetryAfterMs,
        onRetry: ({ attempt, delayMs, error }) => {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn({ torrentFilename: record.torrentFilename, attempt, delayMs, error: message }, 'Retrying peer download after transient failure')
          const retryAt = this.now() + delayMs
          this.setPhase(record.id, 'retry_wait', new Date(retryAt).toISOString())
          repo?.setError(record.id, `${RETRY_WAIT_PREFIX} ${retryTimeFormat.format(retryAt)}: ${message}`)
        },
        signal,
      })

      signal.throwIfAborted()
      repo?.markImportQueued(record.id)
      logger.info({ torrentFilename: record.torrentFilename, filename: record.filename }, 'Download complete')
    }
    catch (err) {
      const message = failureMessage(err, signal)
      // The .part file is preserved by downloadFile on failure, so a later
      // restart re-enqueue can resume from it.
      repo?.markFailed(record.id, message)
      // The stack is what pins down an unexpected error (e.g. a RangeError from a dependency).
      const stack = err instanceof Error ? err.stack : undefined
      logger.error({ torrentFilename: record.torrentFilename, filename: record.filename, error: message, stack }, 'Download failed')
      // A cancel is the user's own doing; only real failures are announced.
      if (!signal.aborted) {
        for (const listener of this.failedListeners) {
          try {
            listener(record, message)
          }
          catch {}
        }
      }
    }
  }
}
