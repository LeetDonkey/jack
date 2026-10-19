import type { DownloadStatus } from '../../database/schema'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { DownloadPhase, DownloadPhaseState } from '../downloads/download-state'
import type { DownloadRecord, DownloadsRepository } from '../downloads/downloads.repository'
import type { DownloadsService } from '../downloads/downloads.service'
import type { PeerHealth, PeerHealthMonitor } from '../friends/peer-health'
import type { RegistrationStatus } from '../registration/registration.service'
import type { TrafficLedger } from '../transfers/traffic-ledger'
import type { RestartReason } from './restart-pending'
import type { SystemNotice } from './system-notices'
import { DOWNLOAD_STATUSES } from '../../database/schema'
import { DOWNLOAD_PHASES, isCancelledByUser } from '../downloads/download-state'
import { serverRegistrationFields } from '../registration/registration.service'

/** The running jack: when it started, what it needs a restart for, and notices for the user. */
export interface SystemStatus {
  bootedAt: string
  restartPending: RestartReason[]
  /** One-time notices until dismissed (see SystemNotices). */
  notices: SystemNotice[]
}

export interface StatusExtras {
  /** Per-server registration results and last contact. */
  registrations?: RegistrationStatus
  system?: () => SystemStatus
  /** More change feeds the overview stream follows (e.g. config saves, for restartPending). */
  subscriptions?: Array<(subscriber: () => void) => () => void>
  /** Each peer's last health check; the overview stream follows its checks. */
  health?: Pick<PeerHealthMonitor, 'get' | 'subscribe'>
  /** Phase (queued, transferring, waiting to retry) of each running download. */
  downloadPhases?: Pick<DownloadsService, 'phaseOf' | 'subscribe'>
  /** Lifetime bytes per direction, for the overview's `lifetime`. */
  traffic?: Pick<TrafficLedger, 'lifetime'>
}

/** A peer's health as the overview shows it. */
export type OverviewPeerHealth = Pick<PeerHealth, 'online' | 'offlineSince' | 'lastSeenAt' | 'lastError' | 'lastErrorCode' | 'checkedAt'>

const UNCHECKED: OverviewPeerHealth = { online: null, offlineSince: null, lastSeenAt: null, lastError: null, lastErrorCode: null, checkedAt: null }

// The management surface can expose richer detail than the public API: every
// connector here carries its URL-derived `id` (the management UI keys edit/delete
// on it) plus its live initialization state, and downloads are enriched with a
// computed `progress` the public download list does not compute.

// Cap the detail lists the dashboard's "needs attention" panel renders. The true
// totals still come through `byStatus`; these arrays only feed the first few rows.
const ATTENTION_LIMIT = 25

// Fallback when no system provider is wired (tests, read-only deployments).
const BOOTED_AT = new Date().toISOString()

function baseConnector(c: ServerConnector) {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    type: c.type,
    initialized: c.isInitialized,
    initializationError: c.initializationError,
  }
}

/**
 * A download row as the management API shows it: the stored record plus
 * `totalBytes`, `progress`, `phase` and `retryAt` (where a `downloading` row is
 * right now; null for other rows, and for one no download runs for in this
 * process) and `cancelledByUser` (a `failed` row the user cancelled).
 */
export function enrichDownload(d: DownloadRecord, phaseOf?: (id: number) => DownloadPhaseState | null) {
  // Prefer the negotiated expected size; fall back to the release-advertised size.
  const totalBytes = d.expectedBytes ?? (d.releaseSize > 0 ? d.releaseSize : null)
  const progress = totalBytes && totalBytes > 0
    ? Math.min(1, d.downloadedBytes / totalBytes)
    : null
  const runtime = d.status === 'downloading' ? phaseOf?.(d.id) ?? null : null
  return {
    ...d,
    totalBytes,
    progress,
    phase: runtime?.phase ?? null,
    retryAt: runtime?.retryAt ?? null,
    cancelledByUser: isCancelledByUser(d),
  }
}

export class StatusController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[], subscribe?: (subscriber: () => void) => () => void },
    private readonly downloads?: DownloadsRepository,
    private readonly extras: StatusExtras = {},
  ) {}

  subscribeOverview(subscriber: () => void): () => void {
    const unsubscribers = [
      this.connectors.subscribe?.(subscriber),
      this.downloads?.subscribe(subscriber),
      this.extras.registrations?.subscribe(subscriber),
      this.extras.health?.subscribe(subscriber),
      this.extras.downloadPhases?.subscribe(subscriber),
      ...(this.extras.subscriptions ?? []).map(subscribe => subscribe(subscriber)),
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe))
    return () => {
      for (const unsubscribe of unsubscribers)
        unsubscribe()
    }
  }

  subscribeDownloads(subscriber: () => void): () => void {
    const unsubscribers = [
      this.downloads?.subscribe(subscriber),
      this.extras.downloadPhases?.subscribe(subscriber),
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe))
    return () => {
      for (const unsubscribe of unsubscribers)
        unsubscribe()
    }
  }

  private enrich = (record: DownloadRecord) => enrichDownload(record, id => this.extras.downloadPhases?.phaseOf(id) ?? null)

  /** Whether download-backed endpoints are available (a repository was injected). */
  get hasDownloads() {
    return this.downloads !== undefined
  }

  private peerHealth(peer: PeerConnector): OverviewPeerHealth {
    if (!this.extras.health)
      return UNCHECKED
    const { online, offlineSince, lastSeenAt, lastError, lastErrorCode, checkedAt } = this.extras.health.get(peer)
    return { online, offlineSince, lastSeenAt, lastError, lastErrorCode, checkedAt }
  }

  getOverview() {
    // Rate-limited; a change arrives on the overview stream.
    this.extras.registrations?.refresh?.()
    const peers = this.connectors.peers
    const servers = this.connectors.servers
    const records = this.downloads?.list() ?? []

    const byStatus = Object.fromEntries(DOWNLOAD_STATUSES.map(s => [s, 0])) as Record<DownloadStatus, number>
    // `bytesMoved` is the lifetime total of bytes actually pulled over the wire
    // (partial transfers count what they got), powering the dashboard's vanity stat.
    let bytesMoved = 0
    // True count of in-flight/queued transfers flagged with a size mismatch, so the
    // dashboard reports an accurate total even though the detail arrays are capped.
    let mismatched = 0
    // Cancelled rows are `failed` in the table but not failures: they count here instead.
    let cancelled = 0
    const enriched = records.map(this.enrich)
    const byPhase = Object.fromEntries(DOWNLOAD_PHASES.map(p => [p, 0])) as Record<DownloadPhase, number>
    for (const record of enriched) {
      if (record.cancelledByUser)
        cancelled++
      else
        byStatus[record.status]++
      if (record.phase)
        byPhase[record.phase]++
      bytesMoved += record.downloadedBytes
      if (record.expectedBytesMismatch && (record.status === 'downloading' || record.status === 'import_queued'))
        mismatched++
    }

    const peerItems = peers.map(p => ({
      ...baseConnector(p),
      version: p.peerVersion,
      build: this.extras.health?.get(p).build ?? null,
      health: this.peerHealth(p),
    }))
    const lifetime = this.extras.traffic?.lifetime()

    return {
      peers: {
        total: peers.length,
        initialized: peers.filter(p => p.isInitialized).length,
        // From the health checks: the peers whose last check passed.
        online: peerItems.filter(p => p.health.online === true).length,
        items: peerItems,
      },
      servers: {
        total: servers.length,
        initialized: servers.filter(s => s.isInitialized).length,
        sources: servers.filter(s => s.canSource).length,
        destinations: servers.filter(s => s.canDestination).length,
        items: servers.map(s => ({
          ...baseConnector(s),
          source: s.canSource,
          destination: s.canDestination,
          ...serverRegistrationFields(s, this.extras.registrations),
        })),
      },
      system: this.extras.system?.() ?? { bootedAt: BOOTED_AT, restartPending: [], notices: [] },
      downloads: {
        total: records.length,
        byStatus,
        cancelled,
        byPhase,
        bytesMoved,
        mismatched,
        // `records` is sorted by updatedAt desc, so each slice is the most recent.
        active: enriched.filter(r => r.status === 'downloading'),
        importQueued: enriched.filter(r => r.status === 'import_queued').slice(0, ATTENTION_LIMIT),
        failed: enriched.filter(r => r.status === 'failed' && !r.cancelledByUser).slice(0, ATTENTION_LIMIT),
      },
      lifetime: {
        downloadedBytes: lifetime?.in ?? 0,
        uploadedBytes: lifetime?.out ?? 0,
        since: lifetime?.since ?? null,
      },
    }
  }

  listDownloads() {
    const records = this.downloads?.list() ?? []
    return { downloads: records.map(this.enrich) }
  }
}
