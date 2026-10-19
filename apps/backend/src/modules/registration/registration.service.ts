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
  /** Plain-language reason for the first failed or skipped test or step; null when nothing needs saying (a paused indexer is in `indexerPaused`). */
  message: string | null
  /** The *arr's own text for each failed test. */
  testErrors: { downloadClient: string | null, indexer: string | null }
  /**
   * Until when the *arr skips jack's indexer after failures; null when it doesn't,
   * or when jack can't tell until when. Radarr and Sonarr only say that they do
   * (see ArrServerConnector.isIndexerPaused), so for them it stays null and
   * `indexerPaused` says so.
   */
  indexerPausedUntil: string | null
  /**
   * Whether the *arr skips jack's indexer after failures, as jack last saw it: after
   * the registration, then every few minutes (see RegistrationService.refreshPauses).
   * Null when jack couldn't tell, or didn't add the indexer.
   */
  indexerPaused: boolean | null
}

/** Read side, for the overview and the server list. */
export interface RegistrationStatus {
  registration: (destinationId: string) => DestinationRegistration | null
  lastContactAt: (destinationId: string) => string | null
  subscribe: (subscriber: () => void) => () => void
  /** Look again whether each *arr skips jack's indexer; cheap, and at most every few minutes. */
  refresh?: () => void
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
  /** How long to wait before testing a failed download client once more (default 5 s). */
  clientRetryDelayMs?: number
}

/** Which *arr API authenticated with the key jack gave it. */
export type ArrContactApi = 'torznab' | 'qbittorrent'

interface TestOutcome {
  status: ArrTestStatus
  message: string | null
  error: string | null
  timedOut?: boolean
  /** Indexer only: passed because the *arr reached jack, but the feed was empty. */
  noResults?: boolean
  /** The *arr ran the test and answered with a failure (not a timeout, not a missing entry). */
  rejected?: boolean
}

/** One destination's last registration, and what jack learnt about it since. */
interface DestinationState {
  name: string
  type: string
  /** When the registration and its tests finished. */
  at: number
  outcome: ManagedRegistrationOutcome
  client: TestOutcome
  indexer: TestOutcome
  /** Whether the *arr skips jack's indexer after failures; null when unknown. */
  paused: boolean | null
  /** When jack last asked the *arr whether it does. */
  pauseCheckedAt: number
  /** The key the registration gave the Jack indexer, for testing a copy again (see retestPaused). */
  indexerKey: string | undefined
}

const DEFAULT_TEST_TIMEOUT_MS = 20_000
const DEFAULT_INDEXER_TEST_TIMEOUT_MS = 45_000
// A download client test the *arr failed runs once more after this long, so a
// one-off failure (a connection cut while jack starts, say) doesn't stick.
const DEFAULT_CLIENT_RETRY_DELAY_MS = 5_000
// Torznab and qBittorrent calls from an *arr arrive every few seconds while it
// polls; the overview only needs to hear about it once a minute.
const CONTACT_NOTIFY_MS = 60_000
// A destination that was down at boot is retried with backoff, up to this gap.
const INIT_RETRY_BASE_MS = 30_000
const INIT_RETRY_MAX_MS = 15 * 60_000
const LATE_INIT_DEBOUNCE_MS = 1000
// How often jack asks each *arr whether it skips jack's indexer (two cheap GETs),
// and how often it tests the feed again in one that does: a pass ends the pause,
// and the feed passes once it has releases.
const PAUSE_CHECK_MS = 2 * 60_000
const PAUSE_TIMER_MS = 5 * 60_000
const PAUSE_RETRY_MS = 30 * 60_000

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
  if (outcome.indexer.status === 'failed') {
    // Only an *arr that tests even a switched-off indexer gets here (see registerIndexer).
    if (outcome.indexer.error && isNoResultsFailure(outcome.indexer.error))
      return `${destName} won't add jack's indexer until your friends have something to share. jack tries again when you add or save a friend.`
    return `jack couldn't add its indexer to ${destName} (${outcome.indexer.error}). Register again.`
  }
  return null
}

// A failed test says more than a failed registration step, which says more than a
// skip; the download client says more than the indexer. A paused indexer isn't a
// message: the UI words it from `indexerPaused`.
function summarize(state: DestinationState): string | null {
  const { name, outcome, client, indexer } = state
  const failed = [client, indexer].find(test => test.status === 'failed' && test.message)
  return failed?.message
    ?? stepFailureMessage(name, outcome)
    ?? client.message
    ?? indexer.message
}

const SKIPPED: TestOutcome = { status: 'skipped', message: null, error: null }
const PASSED: TestOutcome = { status: 'ok', message: null, error: null }

/**
 * Registers jack as Torznab indexer + qBittorrent download client in each
 * auto-register destination, asks the *arr to test both, and keeps the latest
 * result per destination in memory (re-derived on every registration).
 *
 * jack's own tests never pause jack's indexer in the *arr: the indexer test runs
 * on a copy the *arr records nothing for (see ArrServerConnector.testIndexer), and
 * only a test jack knows passes runs on the saved indexer, to end a pause.
 *
 * Registrations run one at a time: each provisions a key and commits it by dropping
 * the destination's other keys, so two overlapping runs would revoke each other's
 * key. The tests run inside the same slot because they use that key.
 */
export class RegistrationService implements RegistrationStatus {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly states = new Map<string, DestinationState>()
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
  // When jack may test the feed again in an *arr that skips its indexer.
  private readonly pauseRetryAt = new Map<string, number>()
  private readonly subscribers = new Set<() => void>()
  private readonly now: () => number
  private readonly testTimeoutMs: number
  private readonly indexerTestTimeoutMs: number
  private readonly clientRetryDelayMs: number
  private retryTimer: ReturnType<typeof setInterval> | undefined
  private pauseTimer: ReturnType<typeof setInterval> | undefined
  private lateInitTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribeConnectors: (() => void) | undefined

  constructor(private readonly deps: RegistrationServiceDeps) {
    this.now = deps.now ?? Date.now
    this.testTimeoutMs = deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
    this.indexerTestTimeoutMs = deps.indexerTestTimeoutMs ?? DEFAULT_INDEXER_TEST_TIMEOUT_MS
    this.clientRetryDelayMs = deps.clientRetryDelayMs ?? DEFAULT_CLIENT_RETRY_DELAY_MS
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

  /**
   * A Radarr/Sonarr authenticated with the key jack gave it. A login to jack's
   * qBittorrent API after a failed test of the download client shows the test
   * failed only that once, so the failure is dropped.
   */
  recordContact(destinationId: string, api?: ArrContactApi): void {
    const now = this.now()
    this.contacts.set(destinationId, now)
    if (api === 'qbittorrent' && this.clearClientFailure(destinationId, now))
      return
    const notified = this.contactNotified.get(destinationId)
    if (notified === undefined || now - notified >= CONTACT_NOTIFY_MS) {
      this.contactNotified.set(destinationId, now)
      this.notify()
    }
  }

  private clearClientFailure(destinationId: string, now: number): boolean {
    const state = this.states.get(destinationId)
    if (state?.client.status !== 'failed' || now <= state.at)
      return false
    logger.info({ destination: state.name, error: state.client.error }, `${state.name} reached jack's download client after its test failed, so jack drops that failure`)
    state.client = PASSED
    this.contactNotified.set(destinationId, now)
    this.publish(destinationId, state)
    return true
  }

  isRegistrable(dest: ArrServerConnector): boolean {
    return dest.enabled && dest.canDestination && dest.autoRegister.enable
  }

  /** Drop the stored result, e.g. after auto-register was turned off for that server. */
  forget(destinationId: string): void {
    this.states.delete(destinationId)
    this.pauseRetryAt.delete(destinationId)
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

  /**
   * Register again where friends could change the result, e.g. after a friend was
   * added: where the indexer step failed (the *arr may have refused the indexer
   * because jack's feed was empty), where the indexer test found the feed empty,
   * and where the *arr skips jack's indexer (a test that passes now ends that).
   * Checked when its turn in the queue comes, so a registration that is running
   * now counts with its result.
   */
  registerAfterFriendChange(): Promise<Array<DestinationRegistration | null>> {
    const check = this.queue.then(() => this.deps.destinations()
      .filter(dest => this.isRegistrable(dest) && dest.isInitialized && this.friendsMatter(dest.id))
      .map((dest) => {
        const message = this.states.get(dest.id)?.outcome.indexer.status === 'failed'
          ? `Friends changed; adding jack's indexer to ${dest.name} again`
          : `Friends changed; testing jack's indexer in ${dest.name} again`
        logger.info({ destination: dest.name }, message)
        return this.register(dest)
      }))
    this.queue = check.catch(() => {})
    return check.then(runs => Promise.all(runs))
  }

  private friendsMatter(destinationId: string): boolean {
    const state = this.states.get(destinationId)
    return state !== undefined && (state.outcome.indexer.status === 'failed' || state.indexer.noResults === true || state.paused === true)
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

  /** For the overview: look again whether the *arrs skip jack's indexer (see refreshPauses). */
  refresh(): void {
    void this.refreshPauses()
  }

  /**
   * Ask each registered *arr again whether it skips jack's indexer, at most every
   * 2 minutes per server. The answer updates the stored result. In one that does,
   * jack tests the feed again 30 minutes after the last test (see retestPaused),
   * which ends the pause once the feed has releases. Never rejects.
   */
  refreshPauses(): Promise<void> {
    const now = this.now()
    const due = this.deps.destinations().filter((dest) => {
      const state = this.states.get(dest.id)
      return state !== undefined && state.outcome.indexer.status === 'ok' && dest.isInitialized && this.isRegistrable(dest)
        && now - state.pauseCheckedAt >= PAUSE_CHECK_MS
    })
    if (due.length === 0)
      return Promise.resolve()
    for (const dest of due)
      this.states.get(dest.id)!.pauseCheckedAt = now
    const retry: ArrServerConnector[] = []
    const check = this.queue.then(async () => {
      for (const dest of due) {
        // A registration that ran in between replaced the state, and checked.
        const state = this.states.get(dest.id)
        if (!state || state.pauseCheckedAt !== now)
          continue
        const paused = await this.readPause(dest, this.deps.internalUrl())
        if (paused === null)
          continue
        if (paused !== state.paused) {
          state.paused = paused
          if (paused)
            logger.info({ destination: dest.name }, `${dest.name} is skipping jack's indexer after earlier errors`)
          this.publish(dest.id, state)
        }
        if (paused && now >= (this.pauseRetryAt.get(dest.id) ?? 0)) {
          this.pauseRetryAt.set(dest.id, now + PAUSE_RETRY_MS)
          if (!await this.retestPaused(dest, state))
            retry.push(dest)
        }
      }
    })
    this.queue = check.catch(() => {})
    return check.then(() => {
      for (const dest of retry) {
        logger.info({ destination: dest.name }, `${dest.name} skips jack's indexer, and jack couldn't test its feed there; registering again`)
        void this.register(dest)
      }
    }, () => {})
  }

  /**
   * Test the feed again in an *arr that skips jack's indexer, without registering
   * again (which gives the indexer a new key and saves both entries again): a test
   * of a copy with the key the indexer has, and when that finds releases, the test
   * of the saved indexer that ends the pause (see resumeIndexer). Runs in the
   * queue, so no registration changes the key meanwhile.
   *
   * False when only a registration can tell: no key from this boot's registration,
   * or a failed test, since the entry may be gone or its key revoked. A test that
   * timed out waited for friends, and a registration would wait the same.
   */
  private async retestPaused(dest: ArrServerConnector, state: DestinationState): Promise<boolean> {
    if (state.indexerKey === undefined)
      return false
    const internalUrl = this.deps.internalUrl()
    const probe = await this.test(dest, 'indexer', internalUrl, state.indexerKey)
    if (probe.timedOut)
      return true
    if (probe.status !== 'ok')
      return false
    state.indexer = probe
    if (probe.noResults) {
      logger.debug({ destination: dest.name }, `${dest.name} skips jack's indexer, and jack's feed has nothing for it yet`)
    }
    else {
      const paused = await this.resumeIndexer(dest, internalUrl, probe)
      if (paused !== null)
        state.paused = paused
      // As after a registration: a pause that starts later is tested at once.
      if (paused === false)
        this.pauseRetryAt.delete(dest.id)
    }
    this.publish(dest.id, state)
    return true
  }

  /**
   * Re-register when a save changes what jack registers:
   * - a saved server: that server, and the save answers with the result;
   * - a new internal URL: every destination gets the new address;
   * - downloads turned on: every destination gets the indexer and download client
   *   that were skipped;
   * - a friend added or saved (also by an invite link or an introduction): every
   *   destination where friends could change the result (see registerAfterFriendChange).
   */
  followConfig(config: Pick<ConfigService, 'onServerSaved' | 'onJackSaved' | 'onDownloadsSaved' | 'onPeerSaved'>): () => void {
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
      config.onPeerSaved(() => {
        void this.registerAfterFriendChange()
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
   * registered once, by its save. Also looks every few minutes whether an *arr
   * skips jack's indexer (see refreshPauses).
   */
  start(
    subscribe: (subscriber: () => void) => () => void,
    { retryIntervalMs = INIT_RETRY_BASE_MS, debounceMs = LATE_INIT_DEBOUNCE_MS, pauseIntervalMs = PAUSE_TIMER_MS }: { retryIntervalMs?: number, debounceMs?: number, pauseIntervalMs?: number } = {},
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
    this.pauseTimer = setInterval(() => void this.refreshPauses(), pauseIntervalMs)
    this.pauseTimer.unref?.()
  }

  stop(): void {
    this.unsubscribeConnectors?.()
    this.unsubscribeConnectors = undefined
    clearInterval(this.retryTimer)
    this.retryTimer = undefined
    clearInterval(this.pauseTimer)
    this.pauseTimer = undefined
    clearTimeout(this.lateInitTimer)
    this.lateInitTimer = undefined
  }

  private publish(destinationId: string, state: DestinationState): DestinationRegistration {
    const result: DestinationRegistration = {
      at: new Date(state.at).toISOString(),
      ...state.outcome,
      clientTest: state.client.status,
      indexerTest: state.indexer.status,
      message: summarize(state),
      testErrors: { downloadClient: state.client.error, indexer: state.indexer.error },
      indexerPausedUntil: null,
      indexerPaused: state.paused,
    }
    this.results.set(destinationId, result)
    this.notify()
    return result
  }

  private async run(dest: ArrServerConnector): Promise<DestinationRegistration> {
    const internalUrl = this.deps.internalUrl()
    let outcome: ManagedRegistrationOutcome
    let indexerKey: string | undefined
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
        onIndexerKey: (key) => {
          indexerKey = key
        },
      })
    }
    catch (err) {
      // Only the key store can throw here; each *arr call is caught per step.
      logger.error({ destination: dest.name, err }, 'Registration failed')
      const failed: RegistrationStep = { status: 'failed', error: describeArrError(err) }
      outcome = { indexer: failed, downloadClient: { ...failed } }
    }

    const tests = await this.runTests(dest, outcome, internalUrl, indexerKey)
    const state: DestinationState = {
      name: dest.name,
      type: dest.type,
      at: this.now(),
      outcome,
      client: tests.client,
      indexer: tests.indexer,
      paused: null,
      pauseCheckedAt: 0,
      indexerKey,
    }
    if (outcome.indexer.status === 'ok') {
      state.paused = await this.resumeIndexer(dest, internalUrl, tests.indexer)
      state.pauseCheckedAt = this.now()
    }
    this.states.set(dest.id, state)
    // This registration tested the feed, so a pause it found waits PAUSE_RETRY_MS
    // for the next test (see refreshPauses).
    if (state.paused)
      this.pauseRetryAt.set(dest.id, state.pauseCheckedAt + PAUSE_RETRY_MS)
    else
      this.pauseRetryAt.delete(dest.id)
    const result = this.publish(dest.id, state)
    this.logTests(dest, result)
    return result
  }

  /**
   * Whether the *arr still skips jack's indexer after this registration (null when
   * it couldn't say). One that does gets a test of the saved indexer when the test
   * of the copy found releases, since that passes and a pass ends the pause; with
   * an empty feed the same test would fail and make the pause longer.
   */
  private async resumeIndexer(dest: ArrServerConnector, internalUrl: string, probe: TestOutcome): Promise<boolean | null> {
    const paused = await this.readPause(dest, internalUrl)
    if (!paused || probe.status !== 'ok' || probe.noResults)
      return paused
    const saved = await this.test(dest, 'indexer', internalUrl)
    if (saved.status === 'ok' && !saved.noResults) {
      logger.info({ destination: dest.name }, `${dest.name} was skipping jack's indexer after earlier errors; it uses it again now that its test passed`)
      return false
    }
    logger.warn({ destination: dest.name, error: saved.error }, `${dest.name} skips jack's indexer, and its test of it didn't pass`)
    return true
  }

  private async readPause(dest: ArrServerConnector, internalUrl: string): Promise<boolean | null> {
    try {
      return await dest.isIndexerPaused('Jack', `${internalUrl}/torznab`)
    }
    catch (err) {
      logger.debug({ destination: dest.name, error: describeArrError(err) }, `Could not ask ${dest.name} whether it skips jack's indexer`)
      return null
    }
  }

  private async runTests(dest: ArrServerConnector, outcome: ManagedRegistrationOutcome, internalUrl: string, indexerKey: string | undefined): Promise<{ client: TestOutcome, indexer: TestOutcome }> {
    if (outcome.reason === 'downloads-off') {
      const message = outcome.indexer.disabledUnbound
        ? `Downloads are off, so jack didn't add itself to ${dest.name}, and it turned off the Jack indexer it had added there before, which had no download client. Turn on Downloads in Settings.`
        : `Downloads are off, so jack didn't add itself to ${dest.name}. Turn on Downloads in Settings.`
      return { client: { ...SKIPPED, message }, indexer: SKIPPED }
    }

    let client: Promise<TestOutcome> = Promise.resolve(SKIPPED)
    if (outcome.downloadClient.status === 'ok') {
      client = this.deps.downloadsActive()
        ? this.testClient(dest, internalUrl)
        // /api/v2 is mounted at boot only, so the test can only fail until then.
        : Promise.resolve({ ...SKIPPED, message: `Restart the jack container so ${dest.name} can use jack's download client.` })
    }
    // A test of a copy, so an empty feed doesn't pause jack's indexer (see testIndexer).
    const indexer = outcome.indexer.status === 'ok' && indexerKey !== undefined
      ? this.test(dest, 'indexer', internalUrl, indexerKey)
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

  // A test the *arr answered with a failure runs once more, and the second answer
  // counts (see DEFAULT_CLIENT_RETRY_DELAY_MS).
  private async testClient(dest: ArrServerConnector, internalUrl: string): Promise<TestOutcome> {
    const first = await this.test(dest, 'downloadClient', internalUrl)
    if (!first.rejected)
      return first
    logger.debug({ destination: dest.name, error: first.error }, `${dest.name}'s test of jack's download client failed; testing again`)
    await Bun.sleep(this.clientRetryDelayMs)
    return this.test(dest, 'downloadClient', internalUrl)
  }

  // `apiKey`: test a copy of the indexer with that key (see testIndexer).
  private async test(dest: ArrServerConnector, kind: 'downloadClient' | 'indexer', internalUrl: string, apiKey?: string): Promise<TestOutcome> {
    const what = kind === 'downloadClient' ? 'download client' : 'indexer'
    const timeoutMs = kind === 'downloadClient' ? this.testTimeoutMs : this.indexerTestTimeoutMs
    let result: ArrProviderTest
    try {
      result = kind === 'downloadClient'
        ? await dest.testDownloadClient('Jack', { timeoutMs })
        : await dest.testIndexer('Jack', `${internalUrl}/torznab`, { timeoutMs, apiKey })
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
      return { ...PASSED, noResults: true }
    const error = errors.join('; ')
    return { status: 'failed', message: explainArrTestFailure(error, { arrName: dest.name, internalUrl }), error, rejected: true }
  }

  private logTests(dest: ArrServerConnector, result: DestinationRegistration): void {
    const fields = { destination: dest.name, clientTest: result.clientTest, indexerTest: result.indexerTest }
    // Every message names the *arr already.
    if (result.clientTest === 'failed' || result.indexerTest === 'failed')
      logger.warn({ ...fields, errors: result.testErrors }, result.message ?? `${dest.name} can't use jack`)
    else if (result.clientTest === 'ok' || result.indexerTest === 'ok')
      logger.info(fields, `${dest.name} tested its connection to jack`)
  }
}
