import type { BuildIdentity, Friend, FriendKey, FriendsLimits, PeerErrorCode, PeerHealth, TrafficWindow } from '~/types/management'
import { formatBytes, friendStatusWords } from './format'
import { formatTimeAgo } from './server-role'

/**
 * Friend words for the Friends page: the card badge, what is wrong with a
 * friend's jack, key usage, limits and the save errors of a peer. The status
 * word itself comes from `friendStatusWords` (utils/format.ts), shared by every page.
 */

export type FriendTone = 'success' | 'error' | 'warning' | 'neutral'

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const DAY_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

// "17 Oct" this year, "17 Oct 2025" before it (local time). Empty for a bad date.
function shortDay(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return ''
  return (date.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(date)
}

// "Alice's", or "your friend's" without a name.
function possessive(name: string, start = false): string {
  const trimmed = name.trim()
  if (trimmed)
    return `${trimmed}'s`
  return start ? 'Your friend\'s' : 'your friend\'s'
}

function who(name: string, start = false): string {
  return name.trim() || (start ? 'Your friend' : 'your friend')
}

const UNREACHABLE_DETAIL: Partial<Record<PeerErrorCode, string>> = {
  timeout: 'It didn\'t answer in time.',
  dns: 'The address doesn\'t resolve. Check it for typos.',
  refused: 'Nothing accepts connections at that address.',
  tls: 'Its HTTPS certificate was rejected.',
  unavailable: 'Their jack or proxy answered with an error.',
}

/**
 * What is wrong with a friend whose last check failed, and what to do about it.
 * Null while the friend is online or not checked yet.
 */
export function peerProblem(name: string, health: Pick<PeerHealth, 'online' | 'lastErrorCode'>): string | null {
  if (health.online !== false)
    return null
  switch (health.lastErrorCode) {
    case 'unauthorized':
      return `${possessive(name, true)} jack rejected your key. They may have revoked it or sent you a new link.`
    case 'forbidden':
      return `${possessive(name, true)} jack is blocking you, possibly banned after failed attempts. Ask ${who(name)} to check their jack.`
    case 'incompatible':
      return `${who(name, true)} needs to update jack before you can download from them again.`
    default: {
      const detail = health.lastErrorCode ? UNREACHABLE_DETAIL[health.lastErrorCode] : undefined
      return `jack can't reach ${possessive(name)} jack.${detail ? ` ${detail}` : ''} Downloads from them wait and retry.`
    }
  }
}

/**
 * The badge on a friend card. Offline shows the status word; the other states
 * describe the friendship, and the card's prompt says which way is missing.
 */
export function friendBadge(friend: Pick<Friend, 'state' | 'name' | 'peer'>, now: Date = new Date()): { label: string, color: FriendTone } {
  switch (friend.state) {
    case 'offline': {
      if (!friend.peer)
        return { label: 'Offline', color: 'error' }
      const status = friendStatusWords(friend.peer, now.getTime())
      return { label: status.label, color: status.tone }
    }
    case 'both':
      return { label: 'Connected both ways', color: 'success' }
    case 'waiting':
      return { label: `Waiting for ${who(friend.name)}`, color: 'neutral' }
    default:
      return { label: 'Only one way', color: 'warning' }
  }
}

// lastUsedTrackedSince is the key's creation unless the key is older than usage
// tracking. A minute of slack covers the two timestamps being written apart.
const TRACKING_SLACK_MS = 60_000

/**
 * When a friend's jack last used a key: "Last connected 3 min ago", "Never used",
 * or "Not seen since 12 Oct" for a key older than usage tracking (or when its
 * creation time isn't known).
 */
export function keyUsage(key: Pick<FriendKey, 'lastUsedAt' | 'lastUsedTrackedSince'>, createdAt: string | null | undefined, now: Date = new Date()): string {
  if (key.lastUsedAt)
    return `Last connected ${formatTimeAgo(key.lastUsedAt, now.getTime())}`
  const tracked = Date.parse(key.lastUsedTrackedSince)
  const created = createdAt ? Date.parse(createdAt) : Number.NaN
  if (!Number.isNaN(created) && !Number.isNaN(tracked) && tracked - created <= TRACKING_SLACK_MS)
    return 'Never used'
  const day = shortDay(key.lastUsedTrackedSince, now)
  return day ? `Not seen since ${day}` : 'Never used'
}

/** "1.2 GB today · 3.4 GB in 7 days · 10 GB in 30 days". */
export function trafficSummary(window: TrafficWindow): string {
  return `${formatBytes(window.today)} today · ${formatBytes(window.week)} in 7 days · ${formatBytes(window.month)} in 30 days`
}

/** The upload limits each friend gets: "2 uploads at once · 50 GB a day". */
export function limitsSummary(limits: FriendsLimits): string {
  const slots = limits.maxConcurrentUploadsPerPeer
  const daily = limits.dailyUploadLimitGiBPerPeer
  return [
    slots == null ? 'no limit on uploads at once' : `${slots} upload${slots === 1 ? '' : 's'} at once`,
    daily == null ? 'no daily limit' : `${daily} GB a day`,
  ].join(' · ')
}

/** "jack 0.1.0 · build 4ca4a2a (17 Oct)", or null when the friend's jack reported neither. */
export function buildSummary(version: string | null, build: BuildIdentity | null, now: Date = new Date()): string | null {
  const parts: string[] = []
  if (version)
    parts.push(`jack ${version}`)
  if (build?.revision) {
    const day = build.buildDate ? shortDay(build.buildDate, now) : ''
    parts.push(`build ${build.revision.slice(0, 7)}${day ? ` (${day})` : ''}`)
  }
  return parts.length ? parts.join(' · ') : null
}

/** The key "Send a new link" replaces: the newest one. */
export function keyToReplace<K extends Pick<FriendKey, 'id'>>(keys: readonly K[]): K | null {
  return keys.reduce<K | null>((newest, key) => (!newest || key.id > newest.id ? key : newest), null)
}

/** Case-insensitive, trimmed name comparison, for keys named after their friend. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase()
  return x !== '' && x === (b ?? '').trim().toLowerCase()
}

/** What a failed save of a friend (POST/PATCH /config/peers) means, in words. */
export interface PeerSaveProblem {
  title: string
  // The technical reason, shown muted under the title.
  detail: string | null
  // Whether saving with `?force=true` can help: the friend's jack didn't answer
  // (yet), as opposed to answering with a no.
  offerForce: boolean
}

const UNREACHABLE: ReadonlySet<PeerErrorCode> = new Set(['timeout', 'dns', 'refused', 'tls', 'unavailable'])

/**
 * Explain a failed save of the friend `name`. Keeping the friend anyway is offered
 * only when their jack didn't answer or its proxy answered 5xx, never when it
 * answered with a no.
 */
export function describePeerSaveError(
  error: { reason: PeerErrorCode | null, upstreamStatus: number | null, message: string | null },
  name: string,
  fallback = 'Could not save this friend.',
): PeerSaveProblem {
  const { reason, upstreamStatus, message } = error
  const unreachable = (reason !== null && UNREACHABLE.has(reason))
    || ((reason === null || reason === 'unknown') && upstreamStatus !== null && upstreamStatus >= 500)
  if (unreachable) {
    const detail = [reason ? UNREACHABLE_DETAIL[reason] : undefined, message].filter(Boolean).join(' ')
    return { title: `Couldn't reach ${possessive(name)} jack. Their jack or proxy may not be set up yet.`, detail: detail || null, offerForce: true }
  }
  switch (reason) {
    case 'unauthorized':
      return { title: `${possessive(name, true)} jack rejected this key. Ask ${who(name)} for a new link.`, detail: message, offerForce: false }
    case 'forbidden':
      return { title: `${possessive(name, true)} jack is blocking you, possibly banned after failed attempts.`, detail: message, offerForce: false }
    case 'incompatible':
      return { title: `${who(name, true)} needs to update jack.`, detail: message, offerForce: false }
    case 'unknown':
      return { title: `Couldn't connect to ${possessive(name)} jack.`, detail: message, offerForce: false }
    default:
      return { title: message ?? fallback, detail: null, offerForce: false }
  }
}
