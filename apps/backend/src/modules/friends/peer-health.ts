import type { PeerConnector } from '../../lib/servers/peer'
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
  checkedAt: string | null
}

export type PeerHealthEvent
  = | { type: 'offline', peer: PeerHealth, offlineMinutes: number }
    | { type: 'back', peer: PeerHealth, offlineMinutes: number }

const CHECK_INTERVAL_MS = 5 * 60_000

interface State {
  health: PeerHealth
  offlineNotified: boolean
}

/**
 * Asks every configured peer for its handshake every 5 minutes, so the friends
 * view can show who is reachable even when nothing is transferring. Emits
 * `offline` once a peer has been unreachable for `offlineAfterMs`, and `back`
 * when such a peer answers again.
 */
export class PeerHealthMonitor {
  private readonly states = new Map<string, State>()
  private readonly listeners = new Set<(event: PeerHealthEvent) => void>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly getPeers: () => PeerConnector[],
    private readonly offlineAfterMs: () => number,
    private readonly now: () => Date = () => new Date(),
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

  list(): PeerHealth[] {
    return this.getPeers().map(peer => this.states.get(peer.id)?.health ?? this.blank(peer))
  }

  async checkAll(): Promise<void> {
    const peers = this.getPeers()
    for (const id of this.states.keys()) {
      if (!peers.some(p => p.id === id))
        this.states.delete(id)
    }
    await Promise.all(peers.map(peer => this.check(peer)))
  }

  private blank(peer: PeerConnector): PeerHealth {
    return { id: peer.id, name: peer.name ?? peer.url, url: peer.url, online: null, version: null, lastSeenAt: null, offlineSince: null, lastError: null, checkedAt: null }
  }

  private async check(peer: PeerConnector): Promise<void> {
    const state = this.states.get(peer.id) ?? { health: this.blank(peer), offlineNotified: false }
    this.states.set(peer.id, state)
    const now = this.now()
    const health = state.health
    health.name = peer.name ?? peer.url
    health.checkedAt = now.toISOString()
    try {
      const handshake = await peer.ping() as { version?: unknown } | null
      const wasOffline = health.offlineSince
      health.online = true
      health.version = typeof handshake?.version === 'string' ? handshake.version : health.version
      health.lastSeenAt = now.toISOString()
      health.lastError = null
      health.offlineSince = null
      if (wasOffline && state.offlineNotified) {
        state.offlineNotified = false
        this.emit({ type: 'back', peer: { ...health }, offlineMinutes: Math.round((now.getTime() - Date.parse(wasOffline)) / 60_000) })
      }
    }
    catch (err) {
      health.online = false
      health.lastError = err instanceof Error ? err.message : String(err)
      health.offlineSince ??= now.toISOString()
      const offlineMs = now.getTime() - Date.parse(health.offlineSince)
      if (!state.offlineNotified && offlineMs >= this.offlineAfterMs()) {
        state.offlineNotified = true
        this.emit({ type: 'offline', peer: { ...health }, offlineMinutes: Math.round(offlineMs / 60_000) })
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
