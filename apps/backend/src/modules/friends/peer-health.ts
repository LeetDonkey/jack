import type { PeerErrorCode } from '../../lib/net/peer-errors'
import type { PeerConnector } from '../../lib/servers/peer'
import type { Notification } from '../notifications/notifications.service'
import { IncompatiblePeerError } from '../../lib/errors/IncompatiblePeerError'
import { classifyPeerError } from '../../lib/net/peer-errors'
import { isPeerVersionCompatible, MIN_PEER_PROTOCOL_VERSION } from '../../lib/version'
import { logger } from '../../logger'

export interface PeerHealth {
  id: string
  name: string
  url: string
  /** null until the first check. */
  online: boolean | null
  version: string | null
  lastSeenAt: string | null
  offlineSince: string | null
  lastError: string | null
  /** Why the last check failed (see PeerErrorCode); null while online or before the first check. */
  lastErrorCode: PeerErrorCode | null
  checkedAt: string | null
}

export type PeerHealthEvent
  = | { type: 'offline', peer: PeerHealth, offlineMinutes: number }
    | { type: 'back', peer: PeerHealth, offlineMinutes: number }

/**
 * The notification for a health event. A failed check isn't always an
 * unreachable peer: a jack that rejects the key, blocks us or runs a version
 * jack can't talk to did answer, and the text says what to do about it.
 */
export function peerHealthNotification(event: PeerHealthEvent): Notification {
  const { name, lastError, lastErrorCode, version } = event.peer
  const minutes = event.offlineMinutes
  if (event.type === 'back')
    return { event: 'peer-back', title: `${name} is back`, message: `${name} answers again after ${minutes} minutes offline.` }
  const detail = lastError ? `\nLast error: ${lastError}` : ''
  switch (lastErrorCode) {
    case 'incompatible':
      return { event: 'peer-offline', title: `${name} needs a newer jack`, message: `${name}'s jack answers, but runs ${version ? `version ${version}` : 'a version'} that jack can't talk to, for ${minutes} minutes now. Downloads from them wait until ${name} updates jack.${detail}` }
    case 'unauthorized':
      return { event: 'peer-offline', title: `${name}'s jack rejected your key`, message: `${name}'s jack has refused the API key you use for them for ${minutes} minutes. Ask ${name} for a new link. Downloads from them wait and retry.${detail}` }
    case 'forbidden':
      return { event: 'peer-offline', title: `${name}'s jack is blocking you`, message: `${name}'s jack has refused jack's requests for ${minutes} minutes, for example after too many failed attempts. Ask ${name} to check their jack. Downloads from them wait and retry.${detail}` }
    default:
      return { event: 'peer-offline', title: `${name} is offline`, message: `jack hasn't reached ${name} for ${minutes} minutes. Downloads from them wait and retry.${detail}` }
  }
}

const CHECK_INTERVAL_MS = 5 * 60_000

/** The connector calls a check makes. */
export type CheckedPeer = Pick<PeerConnector, 'id' | 'name' | 'url' | 'ping' | 'isInitialized' | 'init'>

interface State {
  health: PeerHealth
  offlineNotified: boolean
}

export interface PeerHealthOptions {
  /** Classifies a failed check (default: classifyPeerError, which may look up the host). */
  classify?: (error: unknown, url: string) => Promise<PeerErrorCode>
}

/**
 * Asks every configured peer for its handshake every 5 minutes, so the friends
 * view can show who is reachable even when nothing is transferring. Emits
 * `offline` once a peer has been unreachable for `offlineAfterMs`, and `back`
 * when such a peer answers again.
 *
 * It is the one source of a friend's status: a peer that answers with a version
 * jack can't talk to counts as offline (`incompatible`), and a peer that answers
 * while its connector never connected (down at boot, or added with force) is
 * connected right away.
 */
export class PeerHealthMonitor {
  private readonly states = new Map<string, State>()
  private readonly listeners = new Set<(event: PeerHealthEvent) => void>()
  private readonly subscribers = new Set<() => void>()
  // The check running per peer id, with the connector it checks.
  private readonly running = new Map<string, { peer: CheckedPeer, run: Promise<void> }>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly getPeers: () => CheckedPeer[],
    private readonly offlineAfterMs: () => number,
    private readonly now: () => Date = () => new Date(),
    private readonly options: PeerHealthOptions = {},
  ) {}

  start(): void {
    if (this.timer)
      return
    void this.checkAll()
    this.timer = setInterval(() => void this.checkAll(), CHECK_INTERVAL_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
  }

  onEvent(listener: (event: PeerHealthEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called after every check (one call per checkAll), e.g. to push a new overview. */
  subscribe(subscriber: () => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  list(): PeerHealth[] {
    return this.getPeers().map(peer => this.get(peer))
  }

  /** The peer's last known health (all null before its first check). */
  get(peer: Pick<CheckedPeer, 'id' | 'name' | 'url'>): PeerHealth {
    const health = this.states.get(peer.id)?.health
    return health ? { ...health } : this.blank(peer)
  }

  async checkAll(): Promise<void> {
    const peers = this.getPeers()
    for (const id of this.states.keys()) {
      if (!peers.some(p => p.id === id))
        this.states.delete(id)
    }
    await Promise.all(peers.map(peer => this.run(peer)))
    this.notify()
  }

  /** Check one peer now (after it was added or edited, say). */
  async check(peer: CheckedPeer): Promise<PeerHealth> {
    await this.run(peer)
    this.notify()
    return this.get(peer)
  }

  private blank(peer: Pick<CheckedPeer, 'id' | 'name' | 'url'>): PeerHealth {
    return { id: peer.id, name: peer.name ?? peer.url, url: peer.url, online: null, version: null, lastSeenAt: null, offlineSince: null, lastError: null, lastErrorCode: null, checkedAt: null }
  }

  // One check per peer at a time: a running check of the same connector is
  // shared. Editing a peer without changing its url keeps the id but replaces
  // the connector (new key or headers); a check of the old one may still be
  // running, so the new one runs after it and its result is written last.
  private run(peer: CheckedPeer): Promise<void> {
    const entry = this.running.get(peer.id)
    if (entry?.peer === peer)
      return entry.run
    const run: Promise<void> = (entry ? entry.run.catch(() => {}).then(() => this.ping(peer)) : this.ping(peer))
      .finally(() => {
        if (this.running.get(peer.id)?.run === run)
          this.running.delete(peer.id)
      })
    this.running.set(peer.id, { peer, run })
    return run
  }

  private async ping(peer: CheckedPeer): Promise<void> {
    const state = this.states.get(peer.id) ?? { health: this.blank(peer), offlineNotified: false }
    this.states.set(peer.id, state)
    const now = this.now()
    const health = state.health
    health.name = peer.name ?? peer.url
    health.checkedAt = now.toISOString()
    let version: string | null = null
    try {
      const handshake = await peer.ping() as { version?: unknown } | null
      version = typeof handshake?.version === 'string' ? handshake.version : null
      if (!version || !isPeerVersionCompatible(version))
        throw new IncompatiblePeerError(`${health.name} runs jack ${version ?? 'without a version'}; jack needs ${MIN_PEER_PROTOCOL_VERSION} or newer`)
      const wasOffline = health.offlineSince
      health.version = version
      health.online = true
      health.lastSeenAt = now.toISOString()
      health.lastError = null
      health.lastErrorCode = null
      health.offlineSince = null
      if (wasOffline && state.offlineNotified) {
        state.offlineNotified = false
        this.emit({ type: 'back', peer: { ...health }, offlineMinutes: Math.round((now.getTime() - Date.parse(wasOffline)) / 60_000) })
      }
    }
    catch (err) {
      // Classify first (it may take a DNS lookup), then change the state in one
      // go, so list() never shows a half-updated failure.
      const code = await this.classify(err, peer.url)
      health.version = version ?? health.version
      health.online = false
      health.lastError = err instanceof Error ? err.message : String(err)
      health.lastErrorCode = code
      health.offlineSince ??= now.toISOString()
      const offlineMs = now.getTime() - Date.parse(health.offlineSince)
      if (!state.offlineNotified && offlineMs >= this.offlineAfterMs()) {
        state.offlineNotified = true
        this.emit({ type: 'offline', peer: { ...health }, offlineMinutes: Math.round(offlineMs / 60_000) })
      }
      return
    }
    // The peer answers, so a connector that never connected (down at boot, or
    // kept with force) connects now instead of on its next use. init() is a
    // no-op while a connect is running or done.
    if (!peer.isInitialized) {
      try {
        peer.init()
      }
      catch (err) {
        logger.warn({ peer: peer.name, err }, 'Could not start connecting to a peer that answers again')
      }
    }
  }

  private async classify(error: unknown, url: string): Promise<PeerErrorCode> {
    try {
      return await (this.options.classify ?? classifyPeerError)(error, url)
    }
    catch {
      return 'unknown'
    }
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber()
      }
      catch (err) {
        logger.warn({ err }, 'Peer health subscriber failed')
      }
    }
  }

  private emit(event: PeerHealthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      }
      catch (err) {
        logger.warn({ err }, 'Peer health listener failed')
      }
    }
  }
}
