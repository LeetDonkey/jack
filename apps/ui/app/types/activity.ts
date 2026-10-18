import type {
  CatalogResponse,
  CatalogTitle,
  DownloadItem,
  Overview,
  PeerItem,
  RequestServerOption,
  TransferInfo,
  TransfersSnapshot,
} from '~/types/management'

// Fields the management API added for the Dashboard, Downloads and Friends' library
// pages. Each type extends the shared one in management.ts, so a value of the
// extended type still fits anything that takes the shared one.

// ── Downloads ────────────────────────────────────────────────────────────────

/**
 * Where a `downloading` row is right now. null for other rows, and for a row jack
 * runs no download for in this process (until it runs again after a restart).
 */
export type DownloadPhase = 'queued' | 'transferring' | 'retry_wait'

export type ActivityDownload = DownloadItem & {
  phase: DownloadPhase | null
  // When the next attempt starts (ISO 8601), while `retry_wait`.
  retryAt: string | null
  // A `failed` row the user cancelled. Retry resumes it; it is not a failure.
  cancelledByUser: boolean
}

// ── Overview ─────────────────────────────────────────────────────────────────

/** Why the last health check of a friend's jack failed. */
export type PeerErrorCode = 'timeout' | 'dns' | 'refused' | 'tls' | 'unauthorized' | 'forbidden' | 'incompatible' | 'unavailable' | 'unknown'

/** A friend's last health check (every 5 minutes, and right after the friend is saved). */
export interface PeerHealth {
  // null before the first check.
  online: boolean | null
  offlineSince: string | null
  lastSeenAt: string | null
  lastError: string | null
  lastErrorCode: PeerErrorCode | null
  checkedAt: string | null
}

export interface BuildIdentity {
  revision: string | null
  buildDate: string | null
}

export type OverviewPeer = PeerItem & {
  health: PeerHealth
  build: BuildIdentity | null
}

export interface LifetimeTraffic {
  downloadedBytes: number
  uploadedBytes: number
  // The first day counted (YYYY-MM-DD, server time); null before any traffic.
  since: string | null
}

export type ActivityOverview = Omit<Overview, 'peers' | 'downloads'> & {
  peers: Omit<Overview['peers'], 'items'> & {
    // Friends whose last health check passed.
    online: number
    items: OverviewPeer[]
  }
  downloads: Omit<Overview['downloads'], 'active' | 'importQueued' | 'failed'> & {
    // Rows the user cancelled; `byStatus.failed` leaves them out.
    cancelled: number
    // Running downloads per phase.
    byPhase: Record<DownloadPhase, number>
    active: ActivityDownload[]
    importQueued: ActivityDownload[]
    // Without the rows the user cancelled.
    failed: ActivityDownload[]
  }
  lifetime: LifetimeTraffic
}

// ── Live traffic ─────────────────────────────────────────────────────────────

export type ActivityTransfer = TransferInfo & {
  // The download row this transfer belongs to; null for uploads.
  downloadId: number | null
}

export interface PauseState {
  paused: boolean
  until: string | null
  indefinite: boolean
}

export type ActivityTransfersSnapshot = Omit<TransfersSnapshot, 'transfers'> & {
  transfers: ActivityTransfer[]
  paused: { uploads: PauseState, downloads: PauseState }
}

// ── Friends' library ─────────────────────────────────────────────────────────

export type ActivityCatalogTitle = CatalogTitle & {
  // When the newest release was added at the friend's (ISO 8601); null when none says.
  addedAt: string | null
}

/** A friend whose library is in the catalog, and how old that copy is. */
export interface CatalogPeerFreshness {
  id: string
  name: string
  // The last health check: null before the first one.
  online: boolean | null
  fetchedAt: string
  ageSeconds: number
  // jack just failed to fetch a newer copy and shows the cached one.
  stale: boolean
}

/** A friend with nothing in the catalog: not connected, or failed with no cached copy. */
export interface UnavailableCatalogPeer {
  id: string
  name: string
  online: boolean | null
  error: string | null
}

export type ActivityCatalogResponse = Omit<CatalogResponse, 'peers' | 'titles'> & {
  peers: CatalogPeerFreshness[]
  unavailable: UnavailableCatalogPeer[]
  titles: ActivityCatalogTitle[]
}

/** Why a catalog request can't start a download right now. */
export type DownloadsInactiveReason = 'off' | 'restartPending'

export interface CatalogRequestOptions {
  servers: RequestServerOption[]
  downloadsActive: boolean
  downloadsInactiveReason: DownloadsInactiveReason | null
}

/** POST /catalog/request. `started` is 0 when everything was already downloading. */
export interface CatalogRequestResult {
  ok: true
  // The Radarr/Sonarr it went to.
  server: string
  started: number
}
