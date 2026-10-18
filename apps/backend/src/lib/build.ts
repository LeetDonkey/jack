import process from 'node:process'
import { PROTOCOL_VERSION } from './version'

/** Which build of jack runs: the git commit and when the image was built. */
export interface BuildIdentity {
  /** Git commit the image was built from; null when the build didn't say. */
  revision: string | null
  /** When the image was built (ISO 8601); null when the build didn't say. */
  buildDate: string | null
}

export interface VersionInfo extends BuildIdentity {
  /** The peer-protocol version (the same on every build, see version.ts). */
  version: string
}

// A commit hash or a short tag ("dev"). The value also comes from peers, so
// anything longer or with other characters is dropped rather than shown.
const REVISION_PATTERN = /^[\w.-]{1,64}$/
const MAX_DATE_LENGTH = 40

function revisionOf(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const trimmed = value.trim()
  return REVISION_PATTERN.test(trimmed) ? trimmed : null
}

function dateOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_DATE_LENGTH)
    return null
  const ms = Date.parse(value.trim())
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * This process's build, from JACK_BUILD_REVISION and JACK_BUILD_DATE. The
 * Dockerfile sets both from the REVISION and BUILD_DATE build args; a build
 * without them (or a run from source) reports nulls.
 */
export function buildIdentity(env: Record<string, string | undefined> = process.env): BuildIdentity {
  return { revision: revisionOf(env.JACK_BUILD_REVISION), buildDate: dateOf(env.JACK_BUILD_DATE) }
}

export function versionInfo(env?: Record<string, string | undefined>): VersionInfo {
  return { version: PROTOCOL_VERSION, ...buildIdentity(env) }
}

/**
 * The optional `build` a peer's /handshake reports, or null when it sends none
 * (an older jack, or a build without a revision). Peer-controlled, so every
 * field is checked and an unusable value becomes null.
 */
export function handshakeBuild(handshake: unknown): BuildIdentity | null {
  if (typeof handshake !== 'object' || handshake === null || !('build' in handshake))
    return null
  const build = (handshake as { build?: unknown }).build
  if (typeof build !== 'object' || build === null)
    return null
  const { revision, buildDate } = build as { revision?: unknown, buildDate?: unknown }
  const parsed = { revision: revisionOf(revision), buildDate: dateOf(buildDate) }
  return parsed.revision || parsed.buildDate ? parsed : null
}
