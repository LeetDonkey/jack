import type { DiscoveryConfig } from '../../lib/config'
import type { IntroDirectory, IntroEnvelope, IntroMailRequest, IntroProfile } from '../../lib/introductions/wire'
import type { Identity, IntroStore, IntroThread } from './intro-store'
import { randomUUID } from 'node:crypto'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { ConflictError } from '../../lib/errors/ConflictError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { open, safetyCode, seal, sharedKey } from '../../lib/introductions/crypto'
import { CardPayload, IntroEnvelope as EnvelopeSchema, MessagePayload, RequestPayload, ResponsePayload } from '../../lib/introductions/wire'
import { logger } from '../../logger'

/** The calls one jack makes to a direct friend (implemented by PeerConnector). */
export interface IntroPeer {
  id: string
  name?: string
  url: string
  introProfile: () => Promise<IntroProfile | null>
  introDirectory: () => Promise<IntroDirectory | null>
  introMail: (body: IntroMailRequest) => Promise<{ messages: unknown[] }>
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
  now?: () => Date
}

export interface DirectoryPerson {
  id: string
  name: string
  via: Array<{ peerId: string, name: string }>
  status: 'available' | 'requested' | 'connected'
}

export interface IntroductionsOverview {
  me: { id: string, name: string | null, discoverable: boolean, introduce: boolean, ready: boolean, missing: string[] }
  people: DirectoryPerson[]
  threads: Array<IntroThread & { safetyCode: string }>
}

const PROFILE_TTL_MS = 10 * 60_000
const DIRECTORY_TTL_MS = 5 * 60_000
const SYNC_INTERVAL_MS = 60_000
const MAX_PENDING_OUTGOING = 20

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
  private readonly profiles = new Map<string, { at: number, profile: IntroProfile | null }>()
  private readonly directories = new Map<string, { at: number, directory: IntroDirectory | null }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private syncing: Promise<void> | undefined

  constructor(private readonly deps: IntroductionsDeps) {}

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
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
  }

  // ── What direct friends see ────────────────────────────────────────────────

  profile(): IntroProfile {
    const { id, publicKey } = this.identity
    return { id, publicKey, name: this.publicName, discoverable: Boolean(this.deps.discovery()?.discoverable && this.publicName) }
  }

  /** The friends a caller may ask to meet, or null when this jack doesn't introduce. */
  async directoryFor(apiKeyId: number | undefined): Promise<IntroDirectory | null> {
    if (!(this.deps.discovery()?.introduce ?? true))
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
  async handleMail(apiKeyId: number | undefined, body: IntroMailRequest): Promise<{ messages: IntroEnvelope[] }> {
    if (apiKeyId == null)
      throw new BadRequestError('Introduction mail needs a peer API key')
    if (!this.deps.store.bind(apiKeyId, body.self.id, body.self.publicKey))
      throw new ConflictError('This API key belongs to a different jack identity')
    for (const envelope of body.messages)
      await this.process(envelope, body.self.id)
    const outgoing = this.deps.store.mailFor(body.self.id, this.identity.id)
    this.deps.store.delivered(outgoing.map(e => e.id))
    return { messages: outgoing }
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
    for (const { peer, profile } of await this.peerProfiles()) {
      if (!profile)
        continue
      const outgoing = this.deps.store.mailFor(profile.id, me.id)
      try {
        const { messages } = await peer.introMail({ self: { id: me.id, publicKey: me.publicKey }, messages: outgoing })
        this.deps.store.delivered(outgoing.map(e => e.id))
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

  private async peerProfiles(): Promise<Array<{ peer: IntroPeer, profile: IntroProfile | null }>> {
    const now = this.now.getTime()
    return Promise.all(this.deps.peers().map(async (peer) => {
      const cached = this.profiles.get(peer.id)
      if (cached && now - cached.at < PROFILE_TTL_MS)
        return { peer, profile: cached.profile }
      const profile = await peer.introProfile().catch(() => cached?.profile ?? null)
      this.profiles.set(peer.id, { at: now, profile })
      return { peer, profile }
    }))
  }

  private async peerDirectories(): Promise<Array<{ peer: IntroPeer, directory: IntroDirectory }>> {
    const now = this.now.getTime()
    const all = await Promise.all(this.deps.peers().map(async (peer) => {
      const cached = this.directories.get(peer.id)
      if (cached && now - cached.at < DIRECTORY_TTL_MS)
        return { peer, directory: cached.directory }
      const directory = await peer.introDirectory().catch(() => cached?.directory ?? null)
      this.directories.set(peer.id, { at: now, directory })
      return { peer, directory }
    }))
    return all.filter((d): d is { peer: IntroPeer, directory: IntroDirectory } => d.directory != null)
  }

  // ── Mail handling ──────────────────────────────────────────────────────────

  private async process(envelope: IntroEnvelope, callerId: string): Promise<void> {
    const me = this.identity
    if (!this.deps.store.firstSeen(envelope.id))
      return
    if (envelope.to === me.id) {
      // Delivered by the friend in between, or by the sender itself.
      if (envelope.via === callerId || envelope.from === callerId) {
        try {
          await this.receive(envelope)
        }
        catch (err) {
          logger.error({ from: envelope.fromName, type: envelope.type, err }, 'Could not handle an introduction message')
        }
      }
      return
    }
    // Carried through us: only for our own friends, only when we introduce, and
    // only when the sender handed it over itself.
    if (envelope.via === me.id && envelope.from === callerId && (this.deps.discovery()?.introduce ?? true) && await this.canReach(envelope.to))
      this.deps.store.queue(envelope)
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
    }
    else {
      store.updateThread(thread.requestId, { state: 'connected' })
    }
    logger.info({ peer: thread.peerName }, 'Connected with a friend of a friend')
    void this.sync()
  }

  // ── Actions from the management UI ─────────────────────────────────────────

  private requireReady(): string {
    const name = this.publicName
    if (!name)
      throw new BadRequestError('Set a public name under Settings -> Friends of friends first')
    if (!this.deps.external())
      throw new BadRequestError('Set up quick linking (your external URL) first: it is what a new friend connects to')
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
      throw new BadRequestError('Set up quick linking (your external URL) first')
    const key = this.deps.issueKey(`${thread.peerName} (via ${thread.viaName})`, 'Created when you connected through a mutual friend')
    this.send(thread, 'card', { url: external.url, headers: external.headers, apiKey: key.key })
    return key.id
  }

  async overview(): Promise<IntroductionsOverview> {
    const me = this.identity
    const discovery = this.deps.discovery()
    const name = this.publicName
    const missing = [
      ...(name ? [] : ['a public name']),
      ...(this.deps.external() ? [] : ['quick linking (your external URL)']),
    ]
    const ownPeerIds = new Set((await this.peerProfiles()).map(p => p.profile?.id).filter(Boolean))
    const threads = this.deps.store.threads()
    const people = new Map<string, DirectoryPerson>()
    for (const { peer, directory } of await this.peerDirectories()) {
      for (const person of directory.people) {
        if (person.id === me.id || ownPeerIds.has(person.id))
          continue
        const entry = people.get(person.id) ?? { id: person.id, name: person.name, via: [], status: 'available' as const }
        entry.via.push({ peerId: peer.id, name: directory.introducer.name ?? peer.name ?? peer.url })
        const thread = threads.find(t => t.peerId === person.id && t.state !== 'declined')
        entry.status = thread?.state === 'connected' ? 'connected' : thread ? 'requested' : 'available'
        people.set(person.id, entry)
      }
    }
    return {
      me: { id: me.id, name, discoverable: Boolean(discovery?.discoverable), introduce: discovery?.introduce ?? true, ready: missing.length === 0, missing },
      people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
      threads: threads.map(t => ({ ...t, safetyCode: safetyCode(me.publicKey, t.peerKey) })),
    }
  }

  async request(personId: string, viaPeerId: string, message?: string): Promise<IntroThread> {
    this.requireReady()
    const store = this.deps.store
    if (store.threads().filter(t => t.direction === 'outgoing' && t.state === 'pending').length >= MAX_PENDING_OUTGOING)
      throw new ConflictError('Too many requests waiting for an answer')
    if (store.threads().some(t => t.peerId === personId && t.state !== 'declined'))
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
