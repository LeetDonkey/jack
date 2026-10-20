import type { DiscoveryConfig } from '../../lib/config'
import type { IntroDirectory, IntroEnvelope, IntroMailRequest, IntroProfile } from '../../lib/introductions/wire'
import type { Identity, IntroStore, IntroThread } from './intro-store'
import { randomUUID } from 'node:crypto'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { ConflictError } from '../../lib/errors/ConflictError'
import { IncompatiblePeerError } from '../../lib/errors/IncompatiblePeerError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { open, safetyCode, seal, sharedKey } from '../../lib/introductions/crypto'
import { CardPayload, IntroEnvelope as EnvelopeSchema, MessagePayload, RequestPayload, ResponsePayload } from '../../lib/introductions/wire'
import { peerErrorStatus } from '../../lib/net/peer-errors'
import { logger } from '../../logger'

/** The calls one jack makes to a direct friend (implemented by PeerConnector). */
export interface IntroPeer {
  id: string
  name?: string
  url: string
  /** Whether jack is connected to the peer's jack. */
  isInitialized: boolean
  /** Why connecting failed; null while connecting, or connected. */
  initializationError: string | null
  introProfile: () => Promise<IntroProfile | null>
  introDirectory: () => Promise<IntroDirectory | null>
  introMail: (body: IntroMailRequest) => Promise<{ messages: unknown[], refused?: string[] }>
}

/** What the friend health check last found for a peer (see PeerHealthMonitor). */
export interface IntroPeerHealth {
  /** null before the first check. */
  online: boolean | null
  /** When a check last reached the peer (ISO time). */
  lastSeenAt: string | null
}

export interface IntroductionsDeps {
  store: IntroStore
  discovery: () => DiscoveryConfig | undefined
  /** This jack's external access profile (what a new friend connects to), or null when unset. */
  external: () => { url: string, headers: Record<string, string>, instanceName?: string } | null
  peers: () => IntroPeer[]
  issueKey: (name: string, description: string) => { id: number, key: string }
  apiKeyName: (id: number) => string | null
  addPeer: (peer: { name: string, url: string, apiKey: string, headers: Record<string, string> }) => Promise<void>
  /** Link the key we issued to the peer an introduction added: both are the same friend. */
  linkKey?: (apiKeyId: number, peerUrl: string) => void
  /** The peer id a key is explicitly linked to, or null. */
  keyPeerId?: (apiKeyId: number) => string | null
  /**
   * The friend health check's last result for a peer. Without it, a peer that
   * stops answering is asked again at every sync.
   */
  health?: (peer: IntroPeer) => IntroPeerHealth
  /** How long a caller other than the sync waits for a peer's answer (default ANSWER_WAIT_MS). */
  answerWaitMs?: number
  now?: () => Date
}

export interface DirectoryPerson {
  id: string
  name: string
  via: Array<{ peerId: string, name: string }>
  status: 'available' | 'requested' | 'connected'
}

export interface IntroductionsOverview {
  /** `introducers`: friends' jacks that introduce you (answered the directory at the last round), counted once per jack; null before the first round. */
  me: { id: string, name: string | null, discoverable: boolean, introduce: boolean, ready: boolean, missing: string[], introducers: number | null }
  people: DirectoryPerson[]
  /** `ended`: a connected thread whose person is no longer one of your peers (removed since); you can ask to connect again. */
  threads: Array<IntroThread & { safetyCode: string, ended: boolean }>
}

const PROFILE_TTL_MS = 10 * 60_000
const DIRECTORY_TTL_MS = 5 * 60_000
const SYNC_INTERVAL_MS = 60_000
const MAX_PENDING_OUTGOING = 20
// The Friends page, a friend's directory call and the mail handling wait this
// long for a peer's answer, then go on with what jack has; the call finishes in
// the background and its answer counts from the next caller on. Only the sync
// waits for the answer.
const ANSWER_WAIT_MS = 5_000

interface ProfileEntry {
  /** When the call ended. */
  at: number
  profile: IntroProfile | null
  /** The peer answered the call this boot (a profile, or null when it has no introductions); a failed call keeps the last answer. */
  answered: boolean
  /** The last call failed while jack wasn't connected to the peer: the next sync asks again once it is. */
  untilConnected: boolean
}

interface DirectoryEntry {
  /** When the call ended. */
  at: number
  directory: IntroDirectory | null
  /** The peer answered the directory call once (a directory, or 404 when it doesn't introduce); a failed call keeps the last answer. */
  answered: boolean
}

/**
 * A peer whose connection failed. Any call to it would first connect again, a
 * full handshake that waits out the request timeout when the host doesn't answer
 * (powered off behind a port forward, say). It is left alone until the health
 * check finds it online and connects (see PeerHealthMonitor).
 */
function isDown(peer: IntroPeer): boolean {
  return !peer.isInitialized && peer.initializationError != null
}

/** A failed call the peer (or its proxy) answered, so it costs no timeout. */
function peerAnswered(err: unknown): boolean {
  return peerErrorStatus(err) != null || err instanceof IncompatiblePeerError
}

/** The call's result, or `fallback()` once `ms` have passed; the call goes on either way. */
async function within<T>(call: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), Math.max(0, ms))
  })
  try {
    return await Promise.race([call, late])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Lets two jacks that share a friend find each other and connect, without
 * either learning where the other is until both have said yes.
 *
 * - A jack that opts in (`discovery.discoverable`) shows its public name to its
 *   friends' friends. A friend that allows it (`discovery.introduce`) lists such
 *   names, with a random id and a public key, to its other friends.
 * - Requests, answers and messages travel as end-to-end encrypted envelopes
 *   through that shared friend: every jack syncs mail with each of its peers
 *   once a minute, in the direction it already connects.
 * - Once the other side accepts, both send an encrypted card (external URL,
 *   headers, a fresh API key), and each adds the other as a peer. Only then do
 *   they connect directly.
 */
export class IntroductionsService {
  private readonly profiles = new Map<string, ProfileEntry>()
  // The profile and directory call running per peer: callers that come in
  // meanwhile share it.
  private readonly profileCalls = new Map<string, Promise<IntroProfile | null>>()
  private readonly directories = new Map<string, DirectoryEntry>()
  private readonly directoryCalls = new Map<string, Promise<DirectoryEntry>>()
  // When a call to a peer last got no answer (see reachable).
  private readonly unanswered = new Map<string, number>()
  // The peers left out right now, so going and coming back is logged once.
  private readonly leftOut = new Set<string>()
  private readonly answerWaitMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private syncing: Promise<void> | undefined

  constructor(private readonly deps: IntroductionsDeps) {
    this.answerWaitMs = deps.answerWaitMs ?? ANSWER_WAIT_MS
  }

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private get identity(): Identity {
    return this.deps.store.identity()
  }

  private get publicName(): string | null {
    return this.deps.discovery()?.publicName?.trim() || this.deps.external()?.instanceName?.trim() || null
  }

  start(): void {
    if (this.timer)
      return
    // At once too: the sync fills the peer identities the friends view links by.
    void this.sync()
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
  }

  // ── What the friends view links by ─────────────────────────────────────────

  /**
   * The identity a peer's jack reported: from the syncs' cache, else the last one
   * stored, so a peer that is down (after a restart, say) keeps it. Null when it
   * never reported one.
   */
  peerIdentity(peerId: string): string | null {
    return this.profiles.get(peerId)?.profile?.id ?? this.storedIdentity(peerId)
  }

  /**
   * Whether jack hasn't heard from a peer's jack about its identity since it
   * started: the peer was down at every sync so far, or wasn't synced yet. A
   * health check can find the peer online before the next sync asks.
   */
  identityPending(peerId: string): boolean {
    return !this.profiles.get(peerId)?.answered
  }

  /** A peer's url, and so its id, changed: keep what it reported under the new id. */
  movePeer(oldPeerId: string, newPeerId: string): void {
    this.dropPeer(oldPeerId)
    this.deps.store.movePeer(oldPeerId, newPeerId)
  }

  /** A peer was removed: forget what it reported. */
  forgetPeer(peerId: string): void {
    this.dropPeer(peerId)
    this.deps.store.forgetPeer(peerId)
  }

  private dropPeer(peerId: string): void {
    this.profiles.delete(peerId)
    this.directories.delete(peerId)
    this.unanswered.delete(peerId)
    this.leftOut.delete(peerId)
  }

  private storedIdentity(peerId: string): string | null {
    try {
      return this.deps.store.peerIdentity(peerId)
    }
    catch (err) {
      logger.warn({ err, peerId }, 'Could not read a peer\'s stored identity')
      return null
    }
  }

  private storeIdentity(peerId: string, identityId: string | null): void {
    try {
      this.deps.store.setPeerIdentity(peerId, identityId)
    }
    catch (err) {
      logger.warn({ err, peerId }, 'Could not store a peer\'s identity')
    }
  }

  // The identities our current peers reported, including ones that are down now.
  private knownIdentities(profiles: Array<{ peer: IntroPeer, profile: IntroProfile | null }>): Set<string> {
    const ids = profiles.map(p => p.profile?.id ?? this.storedIdentity(p.peer.id))
    return new Set(ids.filter((id): id is string => id != null))
  }

  /** Every API key a friend's jack used for introduction mail, with its identity. */
  keyBindings(): Array<{ apiKeyId: number, identityId: string, boundAt: string }> {
    return this.deps.store.bindings()
  }

  /** Called when a key is revoked: it no longer speaks for that identity. */
  forgetKey(apiKeyId: number): void {
    this.deps.store.unbind(apiKeyId)
  }

  // A connected thread counts as ended once its person is no longer one of our
  // peers: no current peer reports (or last reported) that identity, and the key
  // we issued in it isn't linked to a current peer either.
  private endedThreads(profiles: Array<{ peer: IntroPeer, profile: IntroProfile | null }>): (thread: IntroThread) => boolean {
    const identities = this.knownIdentities(profiles)
    const peerIds = new Set(this.deps.peers().map(p => p.id))
    return (thread) => {
      if (thread.state !== 'connected' || identities.has(thread.peerId))
        return false
      const linkedPeer = thread.apiKeyId != null ? this.deps.keyPeerId?.(thread.apiKeyId) : null
      return !(linkedPeer && peerIds.has(linkedPeer))
    }
  }

  private linkKey(apiKeyId: number | null, peerUrl: string): void {
    if (apiKeyId == null)
      return
    try {
      this.deps.linkKey?.(apiKeyId, peerUrl)
    }
    catch (err) {
      logger.warn({ err, apiKeyId }, 'Could not link an introduction key to its peer')
    }
  }

  // ── What direct friends see ────────────────────────────────────────────────

  profile(): IntroProfile {
    const { id, publicKey } = this.identity
    return { id, publicKey, name: this.publicName, discoverable: Boolean(this.deps.discovery()?.discoverable && this.publicName) }
  }

  /** The friends a caller may ask to meet, or null when this jack doesn't introduce. */
  async directoryFor(apiKeyId: number | undefined): Promise<IntroDirectory | null> {
    if (!(this.deps.discovery()?.introduce ?? false))
      return null
    const caller = apiKeyId != null ? this.deps.store.boundIdentity(apiKeyId) : null
    const me = this.identity
    const people = (await this.peerProfiles())
      .map(p => p.profile)
      .filter((p): p is IntroProfile => p != null && p.discoverable && p.name != null && p.id !== caller && p.id !== me.id)
      .map(p => ({ id: p.id, name: p.name!, publicKey: p.publicKey }))
    return { introducer: { id: me.id, name: this.publicName }, people: dedupeById(people) }
  }

  /** POST /peer/intro/mail from a friend: take its mail, hand back ours. */
  async handleMail(apiKeyId: number | undefined, body: IntroMailRequest): Promise<{ messages: IntroEnvelope[], refused: string[] }> {
    if (apiKeyId == null)
      throw new BadRequestError('Introduction mail needs a peer API key')
    if (!this.deps.store.bind(apiKeyId, body.self.id, body.self.publicKey))
      throw new ConflictError('This API key belongs to a different jack identity')
    const refused: string[] = []
    for (const envelope of body.messages) {
      if (!await this.process(envelope, body.self.id))
        refused.push(envelope.id)
    }
    // Mail we asked the caller to carry waits while it doesn't introduce: it would
    // refuse the mail, and we'd delete it as delivered.
    const mail = this.deps.store.mailFor(body.self.id, this.identity.id)
    const outgoing = body.introduces === false ? mail.filter(e => e.to === body.self.id) : mail
    this.deps.store.delivered(outgoing.map(e => e.id))
    return { messages: outgoing, refused }
  }

  // ── Syncing with our own peers ─────────────────────────────────────────────

  /** Exchange mail with every peer that speaks the protocol. Overlapping calls share one run. */
  sync(): Promise<void> {
    this.syncing ??= this.syncAll().finally(() => {
      this.syncing = undefined
    })
    return this.syncing
  }

  private async syncAll(): Promise<void> {
    this.deps.store.prune()
    const me = this.identity
    for (const { peer, profile } of await this.peerProfiles({ refresh: true })) {
      // Mail for a peer that is down or doesn't answer waits in the outbox.
      if (!profile || !this.reachable(peer))
        continue
      const outgoing = this.deps.store.mailFor(profile.id, me.id)
      try {
        const { messages, refused } = await this.ask(peer, () => peer.introMail({ self: { id: me.id, publicKey: me.publicKey }, messages: outgoing, introduces: this.deps.discovery()?.introduce ?? false }))
        // What the peer won't carry yet stays in our outbox for the next sync.
        const kept = new Set(refused ?? [])
        this.deps.store.delivered(outgoing.filter(e => !kept.has(e.id)).map(e => e.id))
        for (const raw of messages) {
          const envelope = EnvelopeSchema.safeParse(raw)
          if (envelope.success)
            await this.process(envelope.data, profile.id)
        }
      }
      catch (err) {
        logger.debug({ peer: peer.name, err }, 'Introduction mail sync failed')
      }
    }
  }

  /**
   * Whether to call a peer now. Left out:
   * - a peer that is down (see isDown);
   * - a peer the health check finds offline;
   * - a peer that didn't answer a call, until a health check after that call
   *   reaches it. A friend whose host is off or hung costs every call the full
   *   request timeout, and the health check asks every 5 minutes anyway.
   *
   * Without a health check (see IntroductionsDeps.health) only the first applies.
   */
  private reachable(peer: IntroPeer): boolean {
    if (isDown(peer))
      return false
    const health = this.deps.health?.(peer)
    const failedAt = this.unanswered.get(peer.id)
    if (failedAt !== undefined && health?.lastSeenAt != null && Date.parse(health.lastSeenAt) >= failedAt)
      this.unanswered.delete(peer.id)
    const away = health?.online === false || this.unanswered.has(peer.id)
    if (away !== this.leftOut.has(peer.id)) {
      const name = peer.name ?? peer.url
      if (away) {
        this.leftOut.add(peer.id)
        // Also a friend whose jack answers with a refusal: the health check
        // logs the reason, so this line doesn't claim they don't answer.
        logger.info({ peer: name }, `jack can't reach ${name}; introductions leave them out until it can`)
      }
      else {
        this.leftOut.delete(peer.id)
        logger.info({ peer: name }, `jack reaches ${name} again; introductions include them`)
      }
    }
    return !away
  }

  /** A call to a peer. One that gets no answer leaves the peer out (see reachable). */
  private async ask<T>(peer: IntroPeer, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    }
    catch (err) {
      if (this.deps.health && !peerAnswered(err)) {
        this.unanswered.set(peer.id, this.now.getTime())
        this.reachable(peer)
      }
      throw err
    }
  }

  /**
   * What each peer's jack reported about itself. Only the sync (`refresh`) asks
   * again for what it has: after PROFILE_TTL_MS, or as soon as jack is connected
   * to a peer it couldn't ask before, and only the sync waits for the answer.
   * Every other caller, such as the Friends page or a friend's directory call,
   * asks only a peer it has nothing from yet, and waits until `until`
   * (performance.now() time; default answerWaitMs from now). No caller asks a
   * peer that is left out (see reachable).
   */
  private async peerProfiles({ refresh = false, until = this.waitUntil() }: { refresh?: boolean, until?: number } = {}): Promise<Array<{ peer: IntroPeer, profile: IntroProfile | null }>> {
    const now = this.now.getTime()
    return Promise.all(this.deps.peers().map(async (peer) => {
      const cached = this.profiles.get(peer.id)
      const due = !cached || (refresh && (now - cached.at >= PROFILE_TTL_MS || (cached.untilConnected && peer.isInitialized)))
      if (!due || !this.reachable(peer))
        return { peer, profile: cached?.profile ?? null }
      const call = this.askProfile(peer)
      const profile = refresh ? await call : await within(call, until - performance.now(), () => this.profiles.get(peer.id)?.profile ?? null)
      return { peer, profile }
    }))
  }

  private waitUntil(): number {
    return performance.now() + this.answerWaitMs
  }

  private askProfile(peer: IntroPeer): Promise<IntroProfile | null> {
    const running = this.profileCalls.get(peer.id)
    if (running)
      return running
    const call = (async () => {
      try {
        const profile = await this.ask(peer, () => peer.introProfile())
        // An answer, so the stored identity follows it (null: no introductions there).
        this.storeIdentity(peer.id, profile?.id ?? null)
        this.profiles.set(peer.id, { at: this.now.getTime(), profile, answered: true, untilConnected: false })
        return profile
      }
      catch {
        const last = this.profiles.get(peer.id)
        this.profiles.set(peer.id, { at: this.now.getTime(), profile: last?.profile ?? null, answered: last?.answered ?? false, untilConnected: !peer.isInitialized })
        return last?.profile ?? null
      }
    })()
    this.profileCalls.set(peer.id, call)
    void call.finally(() => {
      if (this.profileCalls.get(peer.id) === call)
        this.profileCalls.delete(peer.id)
    })
    return call
  }

  /**
   * The friends each peer can introduce us to, asked again after
   * DIRECTORY_TTL_MS. Waits until `until` (as in peerProfiles) and never asks a
   * peer that is left out (see reachable): both use the last answer.
   */
  private async peerDirectories({ until = this.waitUntil() }: { until?: number } = {}): Promise<Array<{ peer: IntroPeer, directory: IntroDirectory }>> {
    const now = this.now.getTime()
    const all = await Promise.all(this.deps.peers().map(async (peer) => {
      const cached = this.directories.get(peer.id)
      if ((cached && now - cached.at < DIRECTORY_TTL_MS) || !this.reachable(peer))
        return { peer, directory: cached?.directory ?? null }
      const entry = await within(this.askDirectory(peer), until - performance.now(), () => this.directories.get(peer.id) ?? null)
      return { peer, directory: entry?.directory ?? null }
    }))
    return all.filter((d): d is { peer: IntroPeer, directory: IntroDirectory } => d.directory != null)
  }

  private askDirectory(peer: IntroPeer): Promise<DirectoryEntry> {
    const running = this.directoryCalls.get(peer.id)
    if (running)
      return running
    const call = (async () => {
      let entry: DirectoryEntry
      try {
        const directory = await this.ask(peer, () => peer.introDirectory())
        entry = { at: this.now.getTime(), directory, answered: true }
      }
      catch {
        const last = this.directories.get(peer.id)
        entry = { at: this.now.getTime(), directory: last?.directory ?? null, answered: last?.answered ?? false }
      }
      this.directories.set(peer.id, entry)
      return entry
    })()
    this.directoryCalls.set(peer.id, call)
    void call.finally(() => {
      if (this.directoryCalls.get(peer.id) === call)
        this.directoryCalls.delete(peer.id)
    })
    return call
  }

  // ── Mail handling ──────────────────────────────────────────────────────────

  /** Take one envelope. False when it is ours to carry but we won't now: the sender keeps it. */
  private async process(envelope: IntroEnvelope, callerId: string): Promise<boolean> {
    const me = this.identity
    if (envelope.to !== me.id) {
      // Carried through us: only when the sender handed it over itself, only for
      // our own friends, and only while we introduce. A refused envelope isn't
      // marked seen, so it can still come through later.
      if (envelope.via !== me.id || envelope.from !== callerId)
        return true
      if (!(this.deps.discovery()?.introduce ?? false) || !await this.canReach(envelope.to))
        return false
      if (this.deps.store.firstSeen(envelope.id))
        this.deps.store.queue(envelope)
      return true
    }
    if (!this.deps.store.firstSeen(envelope.id))
      return true
    // Delivered by the friend in between, or by the sender itself.
    if (envelope.via === callerId || envelope.from === callerId) {
      try {
        await this.receive(envelope)
      }
      catch (err) {
        logger.error({ from: envelope.fromName, type: envelope.type, err }, 'Could not handle an introduction message')
      }
    }
    return true
  }

  private async canReach(identityId: string): Promise<boolean> {
    if (this.deps.store.boundIdentities().includes(identityId))
      return true
    return (await this.peerProfiles()).some(p => p.profile?.id === identityId)
  }

  private async viaName(identityId: string): Promise<string> {
    const peer = (await this.peerProfiles()).find(p => p.profile?.id === identityId)
    if (peer)
      return peer.profile?.name ?? peer.peer.name ?? 'a mutual friend'
    return 'a mutual friend'
  }

  private async receive(envelope: IntroEnvelope): Promise<void> {
    let payload: unknown
    try {
      payload = open(sharedKey(this.identity, envelope.fromKey), envelope)
    }
    catch {
      logger.warn({ from: envelope.fromName, type: envelope.type }, 'Dropped an introduction message that could not be decrypted')
      return
    }
    const store = this.deps.store
    const thread = store.thread(envelope.requestId)
    const at = envelope.createdAt

    if (envelope.type === 'request') {
      const request = RequestPayload.safeParse(payload)
      if (thread || !request.success || !this.profile().discoverable)
        return
      // One open request per person: a repeat while one is pending is ignored.
      if (store.threads().some(t => t.peerId === envelope.from && (t.state === 'pending' || t.state === 'accepted')))
        return
      store.createThread({
        requestId: envelope.requestId,
        direction: 'incoming',
        peerId: envelope.from,
        peerName: envelope.fromName,
        peerKey: envelope.fromKey,
        viaId: envelope.via,
        viaName: await this.viaName(envelope.via),
        state: 'pending',
        messages: request.data.message ? [{ from: 'them', text: request.data.message, at }] : [],
      })
      logger.info({ from: envelope.fromName }, 'Received a request to connect from a friend of a friend')
      return
    }

    // Everything else belongs to a thread with this exact person and key.
    if (!thread || thread.peerId !== envelope.from || thread.peerKey !== envelope.fromKey)
      return

    if (envelope.type === 'message') {
      const message = MessagePayload.safeParse(payload)
      if (message.success)
        store.updateThread(thread.requestId, { message: { from: 'them', text: message.data.text, at } })
      return
    }

    if (envelope.type === 'response') {
      const response = ResponsePayload.safeParse(payload)
      if (!response.success || thread.direction !== 'outgoing' || thread.state !== 'pending')
        return
      store.updateThread(thread.requestId, {
        state: response.data.accepted ? 'accepted' : 'declined',
        message: response.data.message ? { from: 'them', text: response.data.message, at } : undefined,
      })
      return
    }

    // A card: the other side's address and a key for us. Only after they accepted
    // (our request) or we accepted (theirs).
    const card = CardPayload.safeParse(payload)
    if (!card.success || thread.state !== 'accepted')
      return
    try {
      await this.deps.addPeer({ name: thread.peerName, url: card.data.url, apiKey: card.data.apiKey, headers: card.data.headers })
    }
    catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      store.updateThread(thread.requestId, { message: { from: 'system', text: `Could not add ${thread.peerName} as a peer: ${reason}`, at } })
      throw err
    }
    if (thread.direction === 'outgoing') {
      // They accepted and sent their card; ours completes the exchange.
      const issued = this.issueCard(thread)
      store.updateThread(thread.requestId, { state: 'connected', apiKeyId: issued })
      this.linkKey(issued, card.data.url)
    }
    else {
      store.updateThread(thread.requestId, { state: 'connected' })
      this.linkKey(thread.apiKeyId, card.data.url)
    }
    logger.info({ peer: thread.peerName }, 'Connected with a friend of a friend')
    void this.sync()
  }

  // ── Actions from the management UI ─────────────────────────────────────────

  private requireReady(): string {
    const name = this.publicName
    if (!name)
      throw new BadRequestError('Set the name friends see under Settings -> Sharing first')
    if (!this.deps.external())
      throw new BadRequestError('Set the address friends use under Settings -> Sharing first: it is what a new friend connects to')
    return name
  }

  private envelope(type: IntroEnvelope['type'], requestId: string, to: { id: string, publicKey: string }, via: string, payload: unknown): IntroEnvelope {
    const me = this.identity
    const header = { v: 1 as const, id: randomUUID(), type, requestId, from: me.id, fromName: this.publicName ?? 'Unnamed jack', fromKey: me.publicKey, to: to.id, via, createdAt: this.now.toISOString() }
    return { ...header, ...seal(sharedKey(me, to.publicKey), header, payload) }
  }

  private send(thread: IntroThread, type: IntroEnvelope['type'], payload: unknown): void {
    this.deps.store.queue(this.envelope(type, thread.requestId, { id: thread.peerId, publicKey: thread.peerKey }, thread.viaId, payload))
  }

  // Issue an API key for the other side and send it with our address. Returns the key id.
  private issueCard(thread: IntroThread): number {
    const external = this.deps.external()
    if (!external)
      throw new BadRequestError('Set the address friends use under Settings -> Sharing first')
    const key = this.deps.issueKey(`${thread.peerName} (via ${thread.viaName})`, 'Created when you connected through a mutual friend')
    this.send(thread, 'card', { url: external.url, headers: external.headers, apiKey: key.key })
    return key.id
  }

  async overview(): Promise<IntroductionsOverview> {
    const me = this.identity
    const discovery = this.deps.discovery()
    const name = this.publicName
    const missing = [
      ...(name ? [] : ['the name friends see']),
      ...(this.deps.external() ? [] : ['the address friends use']),
    ]
    // Directories after profiles, so a peer found down meanwhile isn't asked, and
    // both within one answerWaitMs: the page never waits on a friend for longer.
    const until = this.waitUntil()
    const profiles = await this.peerProfiles({ until })
    // People who already are our peers, also while they are down.
    const ownPeerIds = this.knownIdentities(profiles)
    const ended = this.endedThreads(profiles)
    const threads = this.deps.store.threads()
    const people = new Map<string, DirectoryPerson>()
    const directories = await this.peerDirectories({ until })
    for (const { peer, directory } of directories) {
      for (const person of directory.people) {
        if (person.id === me.id || ownPeerIds.has(person.id))
          continue
        const entry = people.get(person.id) ?? { id: person.id, name: person.name, via: [], status: 'available' as const }
        entry.via.push({ peerId: peer.id, name: directory.introducer.name ?? peer.name ?? peer.url })
        const thread = threads.find(t => t.peerId === person.id && t.state !== 'declined' && !ended(t))
        entry.status = thread?.state === 'connected' ? 'connected' : thread ? 'requested' : 'available'
        people.set(person.id, entry)
      }
    }
    return {
      me: { id: me.id, name, discoverable: Boolean(discovery?.discoverable), introduce: discovery?.introduce ?? false, ready: missing.length === 0, missing, introducers: this.introducers(directories) },
      people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
      threads: threads.map(t => ({ ...t, safetyCode: safetyCode(me.publicKey, t.peerKey), ended: ended(t) })),
    }
  }

  // Friends' jacks that introduce us: a directory at their last answer, one per
  // jack (two addresses of one friend count once). Null while no current peer
  // ever answered, so we can't tell yet.
  private introducers(directories: Array<{ directory: IntroDirectory }>): number | null {
    const peers = this.deps.peers()
    if (peers.length > 0 && !peers.some(peer => this.directories.get(peer.id)?.answered))
      return null
    return new Set(directories.map(d => d.directory.introducer.id)).size
  }

  async request(personId: string, viaPeerId: string, message?: string): Promise<IntroThread> {
    this.requireReady()
    const store = this.deps.store
    if (store.threads().filter(t => t.direction === 'outgoing' && t.state === 'pending').length >= MAX_PENDING_OUTGOING)
      throw new ConflictError('Too many requests waiting for an answer')
    const ended = this.endedThreads(await this.peerProfiles())
    if (store.threads().some(t => t.peerId === personId && t.state !== 'declined' && !ended(t)))
      throw new ConflictError('You already have a request with this person')
    const entry = (await this.peerDirectories()).find(d => d.peer.id === viaPeerId)
    const person = entry?.directory.people.find(p => p.id === personId)
    if (!entry || !person)
      throw new NotFoundError('That person is no longer listed by this friend')
    const requestId = randomUUID()
    const thread: Omit<IntroThread, 'createdAt' | 'updatedAt' | 'apiKeyId'> = {
      requestId,
      direction: 'outgoing',
      peerId: person.id,
      peerName: person.name,
      peerKey: person.publicKey,
      viaId: entry.directory.introducer.id,
      viaName: entry.directory.introducer.name ?? entry.peer.name ?? entry.peer.url,
      state: 'pending',
      messages: message ? [{ from: 'me', text: message, at: this.now.toISOString() }] : [],
    }
    store.createThread(thread)
    this.send(store.thread(requestId)!, 'request', message ? { message } : {})
    void this.sync()
    return store.thread(requestId)!
  }

  private incomingPending(requestId: string): IntroThread {
    const thread = this.deps.store.thread(requestId)
    if (!thread)
      throw new NotFoundError('No such request')
    if (thread.direction !== 'incoming' || thread.state !== 'pending')
      throw new ConflictError('This request has already been answered')
    return thread
  }

  async accept(requestId: string, message?: string): Promise<IntroThread> {
    this.requireReady()
    const thread = this.incomingPending(requestId)
    this.send(thread, 'response', { accepted: true, ...(message ? { message } : {}) })
    const apiKeyId = this.issueCard(thread)
    this.deps.store.updateThread(requestId, {
      state: 'accepted',
      apiKeyId,
      message: message ? { from: 'me', text: message, at: this.now.toISOString() } : undefined,
    })
    void this.sync()
    return this.deps.store.thread(requestId)!
  }

  async decline(requestId: string, message?: string): Promise<IntroThread> {
    const thread = this.incomingPending(requestId)
    this.send(thread, 'response', { accepted: false, ...(message ? { message } : {}) })
    this.deps.store.updateThread(requestId, {
      state: 'declined',
      message: message ? { from: 'me', text: message, at: this.now.toISOString() } : undefined,
    })
    void this.sync()
    return this.deps.store.thread(requestId)!
  }

  async message(requestId: string, text: string): Promise<IntroThread> {
    const thread = this.deps.store.thread(requestId)
    if (!thread)
      throw new NotFoundError('No such request')
    this.send(thread, 'message', { text })
    this.deps.store.updateThread(requestId, { message: { from: 'me', text, at: this.now.toISOString() } })
    void this.sync()
    return this.deps.store.thread(requestId)!
  }
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map(i => [i.id, i])).values()]
}
