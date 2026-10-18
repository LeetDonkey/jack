import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { DestinationRegistration, RegistrationService, RegistrationStatus } from '../registration/registration.service'
import type { ConfigService } from './config.service'
import { z } from 'zod'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { serverRegistrationFields } from '../registration/registration.service'

// How long a save or a register request waits for the registration. The *arr's
// tests can take up to 45 s, and a run can wait behind others; a longer wait would
// run into the management server's 60 s idle timeout and the 60 s default of a
// reverse proxy in front of jack-ui. After it the request answers with
// `registrationPending` and the result arrives on /config/stream and
// /overview/stream.
const DEFAULT_REGISTRATION_WAIT_MS = 25_000

export interface ConfigControllerOptions {
  /** How long a request waits for a registration before answering without it. */
  registrationWaitMs?: number
}

/** A registration a request waited for, or `registrationPending` when it took too long. */
export interface RegistrationAnswer {
  registration: DestinationRegistration | null
  registrationPending: boolean
}

function stringifyConnector(c: ServerConnector) {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    type: c.type,
    initialized: c.isInitialized,
    initializationError: c.initializationError,
  }
}

function stringifyServer(c: ArrServerConnector, status?: RegistrationStatus) {
  return {
    ...stringifyConnector(c),
    source: c.canSource,
    destination: c.canDestination,
    // Effective (defaults-applied) autoregister so the edit form prefills what's
    // actually in effect, not just what the file happened to spell out.
    autoregister: { enable: c.autoRegister.enable, priority: c.autoRegister.priority },
    upgrades: { allow: c.upgrades.allow, maxSizeGiB: c.upgrades.maxSizeGiB ?? null },
    ...serverRegistrationFields(c, status),
  }
}

function stringifyPeer(c: PeerConnector) {
  return { ...stringifyConnector(c), version: c.peerVersion }
}

export class ConfigController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[], subscribe?: (subscriber: () => void) => () => void },
    private readonly configService?: ConfigService,
    private readonly registrations?: Pick<RegistrationService, keyof RegistrationStatus | 'ensureRegistrable' | 'register'>,
    private readonly options: ConfigControllerOptions = {},
  ) {}

  private async awaitRegistration(run: Promise<DestinationRegistration | null>): Promise<RegistrationAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'pending'>((resolve) => {
      timer = setTimeout(resolve, this.options.registrationWaitMs ?? DEFAULT_REGISTRATION_WAIT_MS, 'pending')
    })
    try {
      const result = await Promise.race([run, deadline])
      return result === 'pending'
        ? { registration: null, registrationPending: true }
        : { registration: result, registrationPending: false }
    }
    finally {
      clearTimeout(timer)
    }
  }

  subscribe(subscriber: () => void): () => void {
    const unsubscribers = [
      this.connectors.subscribe?.(subscriber),
      this.configService?.subscribe(subscriber),
      this.registrations?.subscribe(subscriber),
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe))
    return () => {
      for (const unsubscribe of unsubscribers)
        unsubscribe()
    }
  }

  // Merge the persisted, refs-intact `apiKey`/`headers` onto a serialized connector
  // so an edit form can prefill them. Refs (`{env}`/`{file}`) come straight from the
  // file via the ConfigService; the live connector only holds resolved values, so a
  // read-only deployment (no ConfigService) simply omits them.
  private withSecrets<T extends { id: string }>(kind: 'peers' | 'servers', serialized: T) {
    const raw = this.configService?.getRawSecrets(kind, serialized.id)
    if (!raw)
      return serialized
    return { ...serialized, apiKey: raw.apiKey, headers: raw.headers }
  }

  listConfig() {
    return {
      servers: this.connectors.servers.map(s => this.withSecrets('servers', stringifyServer(s, this.registrations))),
      peers: this.connectors.peers.map(p => this.withSecrets('peers', stringifyPeer(p))),
    }
  }

  listPeers() {
    return { peers: this.connectors.peers.map(p => this.withSecrets('peers', stringifyPeer(p))) }
  }

  listServers() {
    return { servers: this.connectors.servers.map(s => this.withSecrets('servers', stringifyServer(s, this.registrations))) }
  }

  /** Whether POST /servers/:id/register is available (a registration service was injected). */
  get canRegister() {
    return this.registrations !== undefined
  }

  /** Register jack in one server now (queued behind any running registration). */
  async registerServer(id: string): Promise<{ ok: true } & RegistrationAnswer> {
    if (!this.registrations)
      throw new Error('Registering requires a registration service')
    const server = this.connectors.servers.find(s => s.id === id)
    if (!server)
      throw new NotFoundError(`No server found with id "${id}"`)
    await this.registrations.ensureRegistrable(server)
    const answer = await this.awaitRegistration(this.registrations.register(server))
    if (!answer.registration && !answer.registrationPending) {
      // The server was removed or changed while the registration waited its turn.
      const live = this.connectors.servers.find(s => s.id === id)
      if (!live)
        throw new NotFoundError(`No server found with id "${id}"`)
      throw new BadRequestError(`${live.name} was changed while the registration waited, and jack no longer registers itself there`)
    }
    return { ok: true, ...answer }
  }

  /** Refs-intact jack config for an edit form, or null when unset / read-only. */
  getJack() {
    return this.configService?.getRawJack() ?? null
  }

  /** Persisted downloads block for an edit form, or null when unset / read-only. */
  getDownloads() {
    return this.configService?.getRawDownloads() ?? null
  }

  /** Whether mutation endpoints are available (a ConfigService was injected). */
  get canMutate() {
    return this.configService !== undefined
  }

  // Single funnel for every mutation: guarantees a service is present and maps a Zod
  // validation failure to a 400. The router only mounts mutation routes when
  // `canMutate`, so the guard here is defensive — direct callers still get a clear error.
  private async run<T>(run: (service: ConfigService) => Promise<T>): Promise<T> {
    if (!this.configService)
      throw new Error('Config mutations require a configured ConfigService')
    try {
      return await run(this.configService)
    }
    catch (err) {
      if (err instanceof z.ZodError)
        throw new BadRequestError(z.prettifyError(err))
      throw err
    }
  }

  private async mutate(run: (service: ConfigService) => Promise<unknown>) {
    await this.run(run)
    return { ok: true }
  }

  addPeer(input: unknown, opts?: { force?: boolean }) {
    return this.mutate(s => s.addPeer(input, opts))
  }

  removePeer(id: string) {
    return this.mutate(s => s.removePeer(id))
  }

  updatePeer(id: string, input: unknown, opts?: { force?: boolean }) {
    return this.mutate(s => s.updatePeer(id, input, opts))
  }

  // Both answer once jack is registered in the saved server (see onServerSaved),
  // or with `registrationPending` when that takes too long.
  async addServer(input: unknown): Promise<{ ok: true } & RegistrationAnswer> {
    const { registration } = await this.run(s => s.addServer(input))
    return { ok: true, ...await this.awaitRegistration(registration) }
  }

  removeServer(id: string) {
    return this.mutate(s => s.removeServer(id))
  }

  async updateServer(id: string, input: unknown): Promise<{ ok: true } & RegistrationAnswer> {
    const { registration } = await this.run(s => s.updateServer(id, input))
    return { ok: true, ...await this.awaitRegistration(registration) }
  }

  updateJack(input: unknown) {
    return this.mutate(s => s.updateJack(input))
  }

  updateJackExternal(input: unknown) {
    return this.mutate(s => s.updateJackExternal(input))
  }

  updateDownloads(input: unknown) {
    return this.mutate(s => s.updateDownloads(input))
  }

  /** Bandwidth block with defaults applied, or null when unset / read-only. */
  getBandwidth() {
    return this.configService?.getBandwidth() ?? null
  }

  updateBandwidth(input: unknown) {
    return this.mutate(s => s.updateBandwidth(input))
  }

  /** Torznab feed settings with defaults applied, or null when read-only. */
  getTorznab() {
    return this.configService?.getTorznab() ?? null
  }

  updateTorznab(input: unknown) {
    return this.mutate(s => s.updateTorznab(input))
  }

  /** The notifications block as stored (secret refs intact), or null when read-only. */
  getNotifications() {
    return this.configService?.getRawNotifications() ?? null
  }

  updateNotifications(input: unknown) {
    return this.mutate(s => s.updateNotifications(input))
  }

  /** Friends-of-friends settings with defaults applied, or null when read-only. */
  getDiscovery() {
    return this.configService?.getDiscovery() ?? null
  }

  updateDiscovery(input: unknown) {
    return this.mutate(s => s.updateDiscovery(input))
  }

  /** Ban settings with defaults applied, or null when read-only. */
  getSecurity() {
    return this.configService?.getSecurity() ?? null
  }

  updateSecurity(input: unknown) {
    return this.mutate(s => s.updateSecurity(input))
  }
}
