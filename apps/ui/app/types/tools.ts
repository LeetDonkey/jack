import type { SecretRef, TransfersSnapshot } from '~/types/management'

// ── Pause (GET /transfers `paused`, POST /transfers/pause and /resume) ───────

/** What a pause stops: `uploads` (sharing with friends) or `downloads` (from friends). */
export type PauseTarget = 'uploads' | 'downloads'

export interface PauseState {
  paused: boolean
  /** When it resumes by itself (ISO 8601); null when not paused or paused until resumed. */
  until: string | null
  /** Paused until someone resumes it. */
  indefinite: boolean
}

export type PauseStates = Record<PauseTarget, PauseState>

/** What POST /transfers/pause and /transfers/resume answer. */
export interface PausesAnswer {
  ok: true
  paused: PauseStates
}

/** GET /transfers and its stream. A jack without pauses sends no `paused`. */
export type TransfersWithPause = TransfersSnapshot & { paused?: PauseStates }

// ── Build identity (GET /version on jack, GET /api/version on jack-ui) ──────

export interface BuildIdentity {
  /** Git commit the image was built from; null when the build didn't say. */
  revision: string | null
  /** When the image was built (ISO 8601); null when the build didn't say. */
  buildDate: string | null
}

export interface JackVersion extends BuildIdentity {
  /** The peer-protocol version, the same on every build. */
  version: string
}

// ── Address friends use (POST /config/jack/external/test) ──────────────────

export interface ExternalCheckBody {
  url: string
  headers?: Record<string, SecretRef>
}

export interface ExternalCheckResult {
  /** jack answered its /ping through this address. */
  ok: boolean
  /** The HTTP status the address answered with; null when nothing answered. */
  status: number | null
  /** What went wrong, in plain words; null when `ok`. */
  error: string | null
  /** The URL that was fetched. */
  url: string
}

// ── Folder check (POST /diagnostics/folders) ────────────────────────────────

/** `ok` passed, `error` found a problem to fix, `unknown` couldn't check. */
export type CheckStatus = 'ok' | 'error' | 'unknown'

export interface PathCheck {
  path: string
  status: CheckStatus
  message: string
}

/** A Radarr/Sonarr that shares its library: can jack see its folders and read its files? */
export interface SourceFolderReport {
  serverId: string
  name: string
  type: string
  status: CheckStatus
  /** Why the server couldn't be checked, or that it has nothing to check; null otherwise. */
  message: string | null
  rootFolders: PathCheck[]
  sampleFiles: PathCheck[]
}

/** Does a Radarr/Sonarr that receives downloads see jack's completed folder at the same path? */
export interface DestinationFolderReport {
  serverId: string
  name: string
  type: string
  status: CheckStatus
  message: string
}

export interface CompletedFolderReport {
  path: string
  status: CheckStatus
  message: string
  exists: boolean
  writable: boolean | null
  /** Free space where the folder lives; null when unknown. */
  freeBytes: number | null
  destinations: DestinationFolderReport[]
}

export interface FolderReport {
  checkedAt: string
  /** No check found a problem; checks that couldn't run don't count. */
  ok: boolean
  sources: SourceFolderReport[]
  /** Null when downloads are off. */
  completed: CompletedFolderReport | null
}

// ── Support info (GET /support-bundle) ──────────────────────────────────────

/** Redacted by jack; copied as it comes. Only the fields the UI reads are typed. */
export interface SupportBundle {
  generatedAt: string
  note: string
  [key: string]: unknown
}
