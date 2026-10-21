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

// lastUsedTrackedSince is the key's creation unless the key is older than usage
// tracking. A minute of slack covers the two timestamps being written apart.
const TRACKING_SLACK_MS = 60_000

// The backend's window for a key in use (KEY_ACTIVE_MS in friend-links.ts):
// a friend counts as stale only after this long without a key use.
const KEY_ACTIVE_MS = 24 * 60 * 60_000

// True when the key is older than jack's record of key use, so "no last use"
// doesn't mean "never used". False while the creation time isn't known.
function olderThanTracking(key: Pick<FriendKey, 'lastUsedTrackedSince'>, createdAt: string | null | undefined): boolean {
  const tracked = Date.parse(key.lastUsedTrackedSince)
  const created = createdAt ? Date.parse(createdAt) : Number.NaN
  return !Number.isNaN(created) && !Number.isNaN(tracked) && tracked - created > TRACKING_SLACK_MS
}

// The latest of these times, or null when there is none.
function latest(times: ReadonlyArray<string | null>): string | null {
  let best: string | null = null
  for (const time of times) {
    if (time && !Number.isNaN(Date.parse(time)) && (best === null || Date.parse(time) > Date.parse(best)))
      best = time
  }
  return best
}

/**
 * Why a friend's jack isn't using the keys you gave them, on a card with both
 * halves that isn't offline:
 * - `waiting`: no key was ever used, so they haven't added you yet.
 * - `quiet`: their jack used a key before, but not in the last 24 hours. `since`
 *   is the last use. For a key older than jack's record of key use it is the day
 *   that record starts, since jack can't tell whether it was ever used.
 * - `tooSoon`: a key is older than jack's record of key use, and that record
 *   started less than 24 hours ago (right after an update). Their jack may well
 *   use the key and just hasn't connected since. Like the backend's `stale`,
 *   it becomes `quiet` after 24 hours without a use.
 *
 * Null for every other card.
 */
export type FriendSilence = { kind: 'waiting' } | { kind: 'quiet', since: string | null } | { kind: 'tooSoon' }

export function friendSilence(
  friend: Pick<Friend, 'state'> & { keys: ReadonlyArray<Pick<FriendKey, 'id' | 'lastUsedAt' | 'lastUsedTrackedSince'>> },
  now: Date,
  keyCreatedAt?: Record<number, string>,
): FriendSilence | null {
  if (friend.state === 'stale')
    return { kind: 'quiet', since: latest(friend.keys.map(key => key.lastUsedAt)) }
  if (friend.state !== 'waiting')
    return null
  const untracked = friend.keys.filter(key => olderThanTracking(key, keyCreatedAt?.[key.id]))
  if (!untracked.length)
    return { kind: 'waiting' }
  const since = latest(untracked.map(key => key.lastUsedTrackedSince))
  if (since && now.getTime() - Date.parse(since) <= KEY_ACTIVE_MS)
    return { kind: 'tooSoon' }
  return { kind: 'quiet', since }
}

type CardFriend = Pick<Friend, 'state' | 'name' | 'peer'> & { keys: ReadonlyArray<Pick<FriendKey, 'id' | 'lastUsedAt' | 'lastUsedTrackedSince'>> }

/**
 * The badge on a friend card. Offline shows the status word; the other states
 * describe the friendship, and the card's prompt says which way is missing.
 * A friend whose jack stopped connecting to yours is "Only one way since …":
 * you may still download from them, and the card says so a few lines below.
 * `keyCreatedAt` (GET /api-keys) tells a never-used key from one older than
 * jack's record of key use.
 */
export function friendBadge(friend: CardFriend, now: Date = new Date(), keyCreatedAt?: Record<number, string>): { label: string, color: FriendTone } {
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
    case 'stale': {
      const silence = friendSilence(friend, now, keyCreatedAt)
      if (silence?.kind === 'tooSoon')
        return { label: `Waiting for ${possessive(friend.name)} jack`, color: 'neutral' }
      if (silence?.kind !== 'quiet')
        return { label: `Waiting for ${who(friend.name)}`, color: 'neutral' }
      const day = silence.since ? shortDay(silence.since, now) : ''
      return { label: day ? `Only one way since ${day}` : 'Only one way for over a day', color: 'warning' }
    }
    default:
      return { label: 'Only one way', color: 'warning' }
  }
}

/** What a friend card asks you to do next, with the button that does it. */
export interface FriendPrompt {
  text: string
  // Muted words after the text.
  hint: string | null
  label: string
  icon: string
  // `checkAddress` opens Settings at your public address.
  action: 'add' | 'invite' | 'newLink' | 'checkAddress'
}

/** The prompt on a friend card, or null when the card needs nothing from you. */
export function friendPrompt(friend: CardFriend, now: Date = new Date(), keyCreatedAt?: Record<number, string>): FriendPrompt | null {
  const name = friend.name
  if (!friend.peer)
    return { text: `You don't download from ${name} yet.`, hint: null, label: `Paste ${name}'s link`, icon: 'i-ph-clipboard-text', action: 'add' }
  if (!friend.keys.length)
    return { text: `${name} can't download from you yet.`, hint: null, label: `Send ${name} a link`, icon: 'i-ph-link', action: 'invite' }
  // Nothing to do while it's too soon to tell (`tooSoon`): their next connection settles it.
  const silence = friendSilence(friend, now, keyCreatedAt)
  if (silence?.kind === 'waiting')
    return { text: `Waiting for ${name} to add you.`, hint: 'They add you by pasting the link you sent. Lost it?', label: 'Send a new link', icon: 'i-ph-link', action: 'newLink' }
  if (silence?.kind === 'quiet') {
    const day = silence.since ? shortDay(silence.since, now) : ''
    return {
      text: `${possessive(name, true)} jack hasn't connected to yours ${day ? `since ${day}` : 'for over a day'}.`,
      hint: `Check that your address still works, and ask ${who(name)} what their jack shows for you.`,
      label: 'Check your address',
      icon: 'i-ph-plugs',
      action: 'checkAddress',
    }
  }
  return null
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

/**
 * What tells a friend's keys apart, as the words after "key": `'Alice laptop'`
 * for a name no other key has, otherwise the day the key was made (`made 12 Oct`),
 * with the time when two keys share the day too, or `#7` while creation times
 * aren't known. Null for a friend's only key when it carries their name: the card
 * already says whose it is.
 */
export function friendKeyLabels(
  friendName: string,
  keys: ReadonlyArray<Pick<FriendKey, 'id' | 'name'>>,
  keyCreatedAt?: Record<number, string>,
  now: Date = new Date(),
): Record<number, string | null> {
  const labels: Record<number, string | null> = {}
  const only = keys.length === 1 ? keys[0]! : null
  if (only && sameName(only.name, friendName)) {
    labels[only.id] = null
    return labels
  }
  const nameCount = new Map<string, number>()
  for (const key of keys) {
    const name = key.name?.trim().toLowerCase() ?? ''
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1)
  }
  for (const key of keys) {
    const name = key.name?.trim() ?? ''
    if (name && nameCount.get(name.toLowerCase()) === 1) {
      labels[key.id] = `'${name}'`
      continue
    }
    const created = keyCreatedAt?.[key.id]
    const day = created ? shortDay(created, now) : ''
    labels[key.id] = day ? `made ${day}` : `#${key.id}`
  }
  // Keys made the same day: add the time, then the number if that's equal too.
  const repeated = (id: number) => keys.some(other => other.id !== id && labels[other.id] === labels[id])
  const sameDay = keys.filter(key => labels[key.id]?.startsWith('made ') && repeated(key.id))
  for (const key of sameDay)
    labels[key.id] = `${labels[key.id]}, ${TIME.format(new Date(keyCreatedAt![key.id]!))}`
  for (const key of sameDay.filter(key => repeated(key.id)))
    labels[key.id] = `${labels[key.id]} (#${key.id})`
  return labels
}

/**
 * When a friend's jack last used a key: "Last connected 3 min ago", "Never used",
 * or "Not connected since 12 Oct" for a key older than usage tracking (or when its
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
  return day ? `Not connected since ${day}` : 'Never used'
}

/** What the Revoke dialog says about one of a friend's keys. */
export interface RevokeKeyWords {
  // How the card names the key: `made 12 Oct`, `'Alice laptop'` or `#7`.
  label: string
  // "Last connected 2 min ago", from keyUsage.
  usage: string
  // Set when their jack uses this key, so revoking it cuts them off.
  warning: { title: string, text: string } | null
  // What revoking does, ending with "This can't be undone."
  text: string
}

type RevokableKey = Pick<FriendKey, 'id' | 'name' | 'lastUsedAt' | 'lastUsedTrackedSince'>

/**
 * The words of the Revoke dialog for one of a friend's keys, or null when the
 * friend has no such key. A friend's jack holds one key for you, so the key it
 * used last is the one it has. Revoking that one cuts the friend off even though
 * their other keys stay valid, so the dialog warns instead of reassuring and
 * points at the older key (or says to wait while the friend hasn't switched to
 * the newer one yet). A tie counts as in use.
 */
export function revokeKeyWords(
  friendName: string,
  keys: ReadonlyArray<RevokableKey>,
  keyId: number,
  keyCreatedAt?: Record<number, string>,
  now: Date = new Date(),
): RevokeKeyWords | null {
  const key = keys.find(k => k.id === keyId)
  if (!key)
    return null
  const labels = friendKeyLabels(friendName, keys, keyCreatedAt, now)
  const labelOf = (k: RevokableKey) => labels[k.id] ?? `#${k.id}`
  const usageOf = (k: RevokableKey) => keyUsage(k, keyCreatedAt?.[k.id], now)
  const others = keys.filter(k => k.id !== key.id)
  const used = key.lastUsedAt ? Date.parse(key.lastUsedAt) : Number.NaN
  const inUse = !Number.isNaN(used) && others.every(other => !(Date.parse(other.lastUsedAt ?? '') > used))
  const base = { label: labelOf(key), usage: usageOf(key) }
  if (!inUse) {
    const rest = others.length === 1 ? ' Their other key keeps working.' : others.length > 1 ? ' Their other keys keep working.' : ''
    return { ...base, warning: null, text: `${possessive(friendName, true)} jack can't use this key once you revoke it.${rest} This can't be undone.` }
  }
  // Keys get increasing ids, so a lower id is an older key.
  const older = others.filter(other => other.id < key.id)
  let instead = ''
  if (older.length === 1) {
    const usage = usageOf(older[0]!)
    instead = ` To revoke the older key instead, cancel and click Revoke next to key ${labelOf(older[0]!)} (${usage.charAt(0).toLowerCase()}${usage.slice(1)}).`
  }
  else if (older.length > 1) {
    instead = ' To revoke an older key instead, cancel and click Revoke next to it.'
  }
  else if (others.length) {
    instead = ` Wait until ${who(friendName)} has pasted your new link, then revoke this key.`
  }
  return {
    ...base,
    warning: {
      title: `${possessive(friendName, true)} jack uses this key.`,
      text: `If you revoke it, ${who(friendName)} can't download from you until they paste a new link.${instead}`,
    },
    text: 'This can\'t be undone.',
  }
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

/**
 * What the limits under a friend's keys apply to. jack counts them per key, and
 * Settings -> Bandwidth says "Each key counts as one friend", so a friend with
 * several keys gets them for each.
 */
export function limitsLabel(keyCount: number): string {
  return keyCount > 1 ? 'Limits for each of their keys' : 'Limits per key'
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
