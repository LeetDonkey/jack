import type { ManagedRegistrationOutcome, RegistrationStep } from '../../lib/autoregister'
import type { ArrProviderTest, ArrServerConnector } from '../../lib/servers/arr/base'
import type { ConfigService } from '../config/config.service'
import type { ManagedApiKeys } from '../managed-keys/managed-keys.service'
import { registerManagedForDestination } from '../../lib/autoregister'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { ConnectorInitializationError } from '../../lib/errors/ConnectorInitializationError'
import { FetchError } from '../../lib/errors/FetchError'
import { describeArrError, formatArrValidationFailure } from '../../lib/servers/arr/validation'
import { logger } from '../../logger'
import { qbCategoryForServer } from '../qbittorrent/qbittorrent.mapper'
import { explainArrTestFailure, explainTestNotRun, isNoResultsFailure } from './explain'

export type ArrTestStatus = 'ok' | 'failed' | 'skipped'

/** What jack registered in one Radarr/Sonarr, and whether that *arr can reach jack. */
export interface DestinationRegistration {
  /** When the registration and its tests finished (ISO 8601). */
  at: string
  indexer: RegistrationStep
  downloadClient: RegistrationStep
  /** Set when both steps were skipped. */
  reason?: 'downloads-off'
  /** The *arr's Test of jack's download client: it reached jack's qBittorrent API. */
  clientTest: ArrTestStatus
  /** The *arr's Test of jack's indexer. "No results" counts as `ok`: it reached jack. */
  indexerTest: ArrTestStatus
  /** Plain-language reason for the first failed or skipped test; null when nothing needs saying. */
  message: string | null
  /** The *arr's own text for each failed test. */
  testErrors: { downloadClient: string | null, indexer: string | null }
}

/** Read side, for the overview and the server list. */
export interface RegistrationStatus {
  registration: (destinationId: string) => DestinationRegistration | null
  lastContactAt: (destinationId: string) => string | null
  subscribe: (subscriber: () => void) => () => void
}

/**
 * What jack registered in this server and when that *arr last reached jack. Both
 * null for a server jack doesn't register itself in, or before anything happened
 * this boot.
 */
export function serverRegistrationFields(server: ArrServerConnector, status?: RegistrationStatus) {
  return {
    registration: status?.registration(server.id) ?? null,
    lastContactAt: status?.lastContactAt(server.id) ?? null,
  }
}

export interface RegistrationServiceDeps {
  managedKeys: ManagedApiKeys
  /** Live destination connectors. */
  destinations: () => ArrServerConnector[]
  /** The internal URL to register, read at the start of every registration. */
  internalUrl: () => string
  /** Whether a downloads block is stored (registration needs one). */
  downloads: () => boolean
  /** Whether jack started with downloads, i.e. serves the qBittorrent API right now. */
  downloadsActive: () => boolean
  now?: () => number
  /** How long the *arr may take to test the download client (default 20 s). */
  testTimeoutMs?: number
  /**
   * How long it may take to test the indexer (default 45 s). Longer: the test runs a
   * Torznab feed request, which waits for every friend.
   */
  indexerTestTimeoutMs?: number
}

interface TestOutcome {
  status: ArrTestStatus
  message: string | null
  error: string | null
  timedOut?: boolean
}

const DEFAULT_TEST_TIMEOUT_MS = 20_000
const DEFAULT_INDEXER_TEST_TIMEOUT_MS = 45_000
// Torznab and qBittorrent calls from an *arr arrive every few seconds while it
// polls; the overview only needs to hear about it once a minute.
const CONTACT_NOTIFY_MS = 60_000
// A destination that was down at boot is retried with backoff, up to this gap.
const INIT_RETRY_BASE_MS = 30_000
const INIT_RETRY_MAX_MS = 15 * 60_000
const LATE_INIT_DEBOUNCE_MS = 1000

function logRegistrationFailure(what: string, destName: string, err: unknown) {
  if (err instanceof FetchError) {
    logger.error({ destination: destName, status: err.extras.status ?? err.response.status, body: err.extras.body }, `Failed to register ${what}`)
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  logger.error({ destination: destName, error: message }, `Failed to register ${what}`)
}

function stepFailureMessage(destName: string, outcome: ManagedRegistrationOutcome): string | null {
  if (outcome.downloadClient.status === 'failed')
    return `jack couldn't add its download client to ${destName} (${outcome.downloadClient.error}), so it left the indexer as it was. Register again.`
  if (outcome.indexer.status === 'failed')
    return `jack couldn't add its indexer to ${destName} (${outcome.indexer.error}). Register again.`
  return null
}

// A failed test says more than a failed registration step, which says more than a
// skip; the download client says more than the indexer.
function summarize(destName: string, outcome: ManagedRegistrationOutcome, client: TestOutcome, indexer: TestOutcome): string | null {
  const failed = [client, indexer].find(test => test.status === 'failed' && test.message)
  return failed?.message ?? stepFailureMessage(destName, outcome) ?? client.message ?? indexer.message
}

const SKIPPED: TestOutcome = { status: 'skipped', message: null, error: null }
const PASSED: TestOutcome = { status: 'ok', message: null, error: null }

/**
 * Registers jack as Torznab indexer + qBittorrent download client in each
 * auto-register destination, asks the *arr to test both, and keeps the latest
 * result per destination in memory (re-derived on every registration).
 *
 * Registrations run one at a time: each provisions a key and commits it by dropping
 * the destination's other keys, so two overlapping runs would revoke each other's
 * key. The tests run inside the same slot because they use that key.
 */
export class RegistrationService implements RegistrationStatus {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly results = new Map<string, DestinationRegistration>()
  private readonly contacts = new Map<string, number>()
  // When subscribers last heard about a contact, per destination.
  private readonly contactNotified = new Map<string, number>()
  // Destinations registered (or queued) since boot; the late-init check skips them.
  private readonly attempted = new Set<string>()
  // A queued run that hasn't started yet absorbs a new request for the same
  // destination: it reads the connector and every input when it starts.
  private readonly waiting = new Map<string, Promise<DestinationRegistration | null>>()
  private readonly initRetries = new Map<string, { attempts: number, nextAt: number }>()
  private readonly subscribers = new Set<() => void>()
  private readonly now: () => number
  private readonly testTimeoutMs: number
  private readonly indexerTestTimeoutMs: number
  private retryTimer: ReturnType<typeof setInterval> | undefined
  private lateInitTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribeConnectors: (() => void) | undefined

  constructor(private readonly deps: RegistrationServiceDeps) {
    this.now = deps.now ?? Date.now
    this.testTimeoutMs = deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
    this.indexerTestTimeoutMs = deps.indexerTestTimeoutMs ?? DEFAULT_INDEXER_TEST_TIMEOUT_MS
  }

  subscribe(subscriber: () => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber()
      }
      catch {
        // Observers must not affect registration.
      }
    }
  }

  registration(destinationId: string): DestinationRegistration | null {
    return this.results.get(destinationId) ?? null
  }

  lastContactAt(destinationId: string): string | null {
    const at = this.contacts.get(destinationId)
    return at === undefined ? null : new Date(at).toISOString()
  }

  /** A Radarr/Sonarr authenticated with the key jack gave it (Torznab or qBittorrent). */
  recordContact(destinationId: string): void {
    const now = this.now()
    this.contacts.set(destinationId, now)
    const notified = this.contactNotified.get(destinationId)
    if (notified === undefined || now - notified >= CONTACT_NOTIFY_MS) {
      this.contactNotified.set(destinationId, now)
      this.notify()
    }
  }

  isRegistrable(dest: ArrServerConnector): boolean {
    return dest.enabled && dest.canDestination && dest.autoRegister.enable
  }

  /** Drop the stored result, e.g. after auto-register was turned off for that server. */
  forget(destinationId: string): void {
    if (this.results.delete(destinationId))
      this.notify()
  }

  /**
   * Queue a registration (plus tests) for one destination. Never rejects.
   *
   * The run looks the destination up again when its turn comes, because it can
   * wait behind other runs for minutes. A server that was removed or stopped
   * auto-registering by then is left alone and the run resolves to null. One that
   * was saved again runs with its current priority, categories and key.
   */
  register(dest: ArrServerConnector): Promise<DestinationRegistration | null> {
    this.attempted.add(dest.id)
    const waiting = this.waiting.get(dest.id)
    if (waiting)
      return waiting
    const run: Promise<DestinationRegistration | null> = this.queue.then(() => {
      if (this.waiting.get(dest.id) === run)
        this.waiting.delete(dest.id)
      const live = this.deps.destinations().find(d => d.id === dest.id)
      if (!live || !this.isRegistrable(live)) {
        this.forget(dest.id)
        return null
      }
      return this.run(live)
    })
    this.waiting.set(dest.id, run)
    this.queue = run.catch(() => {})
    return run
  }

  /** Register every initialized auto-register destination, in order. */
  registerAll(): Promise<Array<DestinationRegistration | null>> {
    const registrable = this.deps.destinations().filter(dest => this.isRegistrable(dest) && dest.isInitialized)
    return Promise.all(registrable.map(dest => this.register(dest)))
  }

  /**
   * Check a request to register one server now: it must be an auto-register
   * destination, and one that is down gets one connection attempt. Throws a
   * BadRequestError or a ConnectorInitializationError; `register` comes next.
   */
  async ensureRegistrable(dest: ArrServerConnector): Promise<void> {
    if (!dest.canDestination)
      throw new BadRequestError(`${dest.name} isn't a destination, so jack doesn't register itself there`)
    if (!dest.autoRegister.enable)
      throw new BadRequestError(`Auto-register is off for ${dest.name}`)
    if (dest.isInitialized)
      return
    dest.init()
    try {
      await dest.initialization
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ConnectorInitializationError(`Could not connect to server "${dest.name}": ${message}`, err)
    }
  }

  /**
   * Register destinations that came online after boot (Radarr starting after jack),
   * once each. Servers saved in the UI are registered by their save instead.
   */
  registerNewlyInitialized(): void {
    for (const dest of this.deps.destinations()) {
      if (!this.isRegistrable(dest) || !dest.isInitialized || this.attempted.has(dest.id))
        continue
      logger.info({ destination: dest.name }, `${dest.name} is reachable now; registering jack in it`)
      void this.register(dest)
    }
  }

  /** Retry connecting to auto-register destinations that are down, with backoff. */
  retryUninitialized(now = this.now()): void {
    const seen = new Set<string>()
    for (const dest of this.deps.destinations()) {
      seen.add(dest.id)
      if (!this.isRegistrable(dest) || dest.isInitialized) {
        this.initRetries.delete(dest.id)
        continue
      }
      const state = this.initRetries.get(dest.id) ?? { attempts: 0, nextAt: 0 }
      if (now < state.nextAt)
        continue
      dest.init()
      state.attempts++
      state.nextAt = now + Math.min(INIT_RETRY_BASE_MS * 2 ** (state.attempts - 1), INIT_RETRY_MAX_MS)
      this.initRetries.set(dest.id, state)
    }
    for (const id of this.initRetries.keys()) {
      if (!seen.has(id))
        this.initRetries.delete(id)
    }
  }

  /**
   * Re-register when a save changes what jack registers:
   * - a saved server: that server, and the save answers with the result;
   * - a new internal URL: every destination gets the new address;
   * - downloads turned on: every destination gets the indexer and download client
   *   that were skipped.
   */
  followConfig(config: Pick<ConfigService, 'onServerSaved' | 'onJackSaved' | 'onDownloadsSaved'>): () => void {
    const unsubscribers = [
      config.onServerSaved((id) => {
        const dest = this.deps.destinations().find(d => d.id === id)
        if (dest?.isInitialized && this.isRegistrable(dest))
          return this.register(dest)
        this.forget(id)
        return Promise.resolve(null)
      }),
      config.onJackSaved((previous, next) => {
        if (previous?.internalUrl === next.internalUrl)
          return
        logger.info({ internalUrl: next.internalUrl }, 'Internal URL changed; registering jack in Radarr/Sonarr again')
        void this.registerAll()
      }),
      // /api/v2 still starts only with the next boot (see restartPending).
      config.onDownloadsSaved((previous) => {
        if (previous)
          return
        logger.info('Downloads turned on; registering jack in Radarr/Sonarr again')
        void this.registerAll()
      }),
    ]
    return () => {
      for (const unsubscribe of unsubscribers)
        unsubscribe()
    }
  }

  /**
   * Watch for destinations that come online later: `subscribe` is the connector
   * manager's change feed. The check is debounced so a server saved in the UI is
   * registered once, by its save.
   */
  start(
    subscribe: (subscriber: () => void) => () => void,
    { retryIntervalMs = INIT_RETRY_BASE_MS, debounceMs = LATE_INIT_DEBOUNCE_MS }: { retryIntervalMs?: number, debounceMs?: number } = {},
  ): void {
    this.stop()
    this.unsubscribeConnectors = subscribe(() => {
      if (this.lateInitTimer)
        return
      this.lateInitTimer = setTimeout(() => {
        this.lateInitTimer = undefined
        this.registerNewlyInitialized()
      }, debounceMs)
      this.lateInitTimer.unref?.()
    })
    this.retryTimer = setInterval(() => this.retryUninitialized(), retryIntervalMs)
    this.retryTimer.unref?.()
  }

  stop(): void {
    this.unsubscribeConnectors?.()
    this.unsubscribeConnectors = undefined
    clearInterval(this.retryTimer)
    this.retryTimer = undefined
    clearTimeout(this.lateInitTimer)
    this.lateInitTimer = undefined
  }

  private async run(dest: ArrServerConnector): Promise<DestinationRegistration> {
    const internalUrl = this.deps.internalUrl()
    let outcome: ManagedRegistrationOutcome
    try {
      outcome = await registerManagedForDestination(dest, {
        managedKeys: this.deps.managedKeys,
        internalUrl,
        downloads: this.deps.downloads(),
        category: qbCategoryForServer(dest.id),
        onSuccess: (kind, name, meta) => {
          if (kind === 'download client')
            logger.info({ destination: name, downloadClientId: meta.downloadClientId }, 'Registered Jack as qBittorrent download client')
          else
            logger.info({ destination: name, categories: meta.categories, downloadClientId: meta.downloadClientId }, 'Registered Jack as Torznab indexer')
        },
        onFailure: logRegistrationFailure,
      })
    }
    catch (err) {
      // Only the key store can throw here; each *arr call is caught per step.
      logger.error({ destination: dest.name, err }, 'Registration failed')
      const failed: RegistrationStep = { status: 'failed', error: describeArrError(err) }
      outcome = { indexer: failed, downloadClient: { ...failed } }
    }

    const tests = await this.runTests(dest, outcome, internalUrl)
    const result: DestinationRegistration = {
      at: new Date(this.now()).toISOString(),
      ...outcome,
      clientTest: tests.client.status,
      indexerTest: tests.indexer.status,
      message: summarize(dest.name, outcome, tests.client, tests.indexer),
      testErrors: { downloadClient: tests.client.error, indexer: tests.indexer.error },
    }
    this.logTests(dest, result)
    this.results.set(dest.id, result)
    this.notify()
    return result
  }

  private async runTests(dest: ArrServerConnector, outcome: ManagedRegistrationOutcome, internalUrl: string): Promise<{ client: TestOutcome, indexer: TestOutcome }> {
    if (outcome.reason === 'downloads-off') {
      const message = outcome.indexer.disabledUnbound
        ? `Downloads are off, so jack didn't add itself to ${dest.name}, and it turned off the Jack indexer it had added there before, which had no download client. Turn on Downloads in Settings.`
        : `Downloads are off, so jack didn't add itself to ${dest.name}. Turn on Downloads in Settings.`
      return { client: { ...SKIPPED, message }, indexer: SKIPPED }
    }

    let client: Promise<TestOutcome> = Promise.resolve(SKIPPED)
    if (outcome.downloadClient.status === 'ok') {
      client = this.deps.downloadsActive()
        ? this.test(dest, 'downloadClient', internalUrl)
        // /api/v2 is mounted at boot only, so the test can only fail until then.
        : Promise.resolve({ ...SKIPPED, message: `Restart the jack container so ${dest.name} can use jack's download client.` })
    }
    const indexer = outcome.indexer.status === 'ok'
      ? this.test(dest, 'indexer', internalUrl)
      : Promise.resolve(SKIPPED)
    const [clientResult, indexerResult] = await Promise.all([client, indexer])
    // The download client answered, so the address works: a slow indexer test
    // means jack's feed waited for friends.
    if (indexerResult.timedOut && clientResult.status === 'ok') {
      const seconds = Math.round(this.indexerTestTimeoutMs / 1000)
      indexerResult.message = `${dest.name} reached jack, but the indexer test took longer than ${seconds} seconds. jack waits for friends that don't answer, so check the Friends page.`
    }
    return { client: clientResult, indexer: indexerResult }
  }

  private async test(dest: ArrServerConnector, kind: 'downloadClient' | 'indexer', internalUrl: string): Promise<TestOutcome> {
    const what = kind === 'downloadClient' ? 'download client' : 'indexer'
    const timeoutMs = kind === 'downloadClient' ? this.testTimeoutMs : this.indexerTestTimeoutMs
    let result: ArrProviderTest
    try {
      result = kind === 'downloadClient'
        ? await dest.testDownloadClient('Jack', { timeoutMs })
        : await dest.testIndexer('Jack', `${internalUrl}/torznab`, { timeoutMs })
    }
    catch (err) {
      const error = describeArrError(err)
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      return {
        status: 'failed',
        message: explainTestNotRun(error, { arrName: dest.name, timedOut, timeoutSeconds: Math.round(timeoutMs / 1000), internalUrl }),
        error,
        timedOut,
      }
    }

    if (result.status === 'ok')
      return PASSED
    if (result.status === 'missing')
      return { status: 'failed', message: `${dest.name} has no Jack ${what} anymore. Register again.`, error: null }

    const errors = result.failures.filter(failure => !failure.warning).map(formatArrValidationFailure)
    if (kind === 'indexer' && errors.every(isNoResultsFailure))
      return PASSED
    const error = errors.join('; ')
    return { status: 'failed', message: explainArrTestFailure(error, { arrName: dest.name, internalUrl }), error }
  }

  private logTests(dest: ArrServerConnector, result: DestinationRegistration): void {
    const fields = { destination: dest.name, clientTest: result.clientTest, indexerTest: result.indexerTest }
    if (result.clientTest === 'failed' || result.indexerTest === 'failed')
      logger.warn({ ...fields, errors: result.testErrors }, `${dest.name} can't use jack: ${result.message}`)
    else if (result.clientTest === 'ok' || result.indexerTest === 'ok')
      logger.info(fields, `${dest.name} tested its connection to jack`)
  }
}
