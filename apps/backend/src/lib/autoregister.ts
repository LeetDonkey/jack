import type { ManagedApiKeys } from '../modules/managed-keys/managed-keys.service'
import type { ArrServerConnector } from './servers/arr/base'
import { logger } from '../logger'
import { describeArrError } from './servers/arr/validation'

export interface ManagedRegistrationMeta {
  downloadClientId?: number
  categories?: number[]
}

export type RegistrationStepStatus = 'ok' | 'failed' | 'skipped'

/**
 * Why a registration step was skipped:
 * - `downloads-off`: no downloads block, so jack registers nothing;
 * - `client-failed`: the download client step failed, so jack left the indexer as
 *   it was rather than unbind it from jack's client.
 */
export type RegistrationSkipReason = 'downloads-off' | 'client-failed'

export interface RegistrationStep {
  status: RegistrationStepStatus
  /** What went wrong, as the *arr (or the network) reported it. Only on `failed`. */
  error?: string
  /** Only on `skipped`. */
  reason?: RegistrationSkipReason
  /**
   * Indexer only, with downloads off: jack turned off the Jack indexer an earlier
   * jack added to the *arr, because it had no download client bound.
   */
  disabledUnbound?: true
}

export interface ManagedRegistrationOutcome {
  indexer: RegistrationStep
  downloadClient: RegistrationStep
  /** Set when nothing was registered, with the reason both steps were skipped. */
  reason?: 'downloads-off'
}

export interface ManagedRegistrationDeps {
  managedKeys: ManagedApiKeys
  internalUrl: string
  downloads: boolean
  category: string
  onSuccess: (kind: 'download client' | 'indexer', name: string, meta: ManagedRegistrationMeta) => void
  onFailure: (kind: 'download client' | 'indexer', name: string, err: unknown) => void
}

// Without downloads an indexer with no bound download client is the trap: *arr
// hands jack's stub .torrent to whatever other torrent client it has, where it
// never starts. Earlier versions registered the indexer anyway, so turn such a
// leftover off. Registering with downloads on turns it back on, bound.
async function disableUnboundIndexer(dest: ArrServerConnector, internalUrl: string): Promise<boolean> {
  try {
    const disabled = await dest.disableUnboundIndexer('Jack', `${internalUrl}/torznab`)
    if (disabled)
      logger.warn({ destination: dest.name }, `Turned off the Jack indexer in ${dest.name}: it has no download client, and downloads are off`)
    return disabled
  }
  catch (err) {
    logger.warn({ destination: dest.name, error: describeArrError(err) }, `Could not check ${dest.name} for an unbound Jack indexer`)
    return false
  }
}

/**
 * Provision a fresh managed key for one destination and register Jack as its qBittorrent
 * download client + Torznab indexer using that key. Rollback-safe:
 * - every registration succeeded → commit (drop the previous key);
 * - one of the two succeeded → keep both old + new (each consumer holds a valid key);
 * - nothing was delivered to *arr → discard the new key (it would only linger as a
 *   valid-but-unused credential; the old keys stay valid for retry next boot).
 *
 * Without downloads nothing is registered, not even the indexer (see
 * disableUnboundIndexer). Registering again once downloads are set up adds both.
 *
 * When the download client step fails, the indexer is left as it was: registering
 * it without a client id would reset its binding to "Any" client.
 */
export async function registerManagedForDestination(
  dest: ArrServerConnector,
  deps: ManagedRegistrationDeps,
): Promise<ManagedRegistrationOutcome> {
  const { managedKeys, internalUrl, downloads, category } = deps
  if (!downloads) {
    const indexer: RegistrationStep = { status: 'skipped', reason: 'downloads-off' }
    if (await disableUnboundIndexer(dest, internalUrl))
      indexer.disabledUnbound = true
    return { indexer, downloadClient: { status: 'skipped', reason: 'downloads-off' }, reason: 'downloads-off' }
  }

  const { id: keyId, key } = managedKeys.provision(dest.id)

  let downloadClientId: number | undefined
  let downloadClient: RegistrationStep
  try {
    downloadClientId = await dest.registerDownloadClient({
      name: 'Jack',
      internalUrl,
      username: dest.name,
      password: key,
      category,
    })
    downloadClient = { status: 'ok' }
    deps.onSuccess('download client', dest.name, { downloadClientId })
  }
  catch (err) {
    downloadClient = { status: 'failed', error: describeArrError(err) }
    deps.onFailure('download client', dest.name, err)
  }

  let indexer: RegistrationStep
  if (downloadClient.status !== 'ok') {
    indexer = { status: 'skipped', reason: 'client-failed' }
  }
  else {
    try {
      await dest.registerIndexer({
        name: 'Jack',
        internalUrl: `${internalUrl}/torznab`,
        apiKey: key,
        priority: dest.autoRegister.priority,
        categories: dest.categories,
        downloadClientId,
      })
      indexer = { status: 'ok' }
      deps.onSuccess('indexer', dest.name, { downloadClientId, categories: dest.categories })
    }
    catch (err) {
      indexer = { status: 'failed', error: describeArrError(err) }
      deps.onFailure('indexer', dest.name, err)
    }
  }

  const delivered = [downloadClient, indexer].filter(step => step.status === 'ok').length
  if (delivered === 2)
    managedKeys.commit(dest.id, keyId)
  else if (delivered === 0)
    managedKeys.discard(keyId)
  // else: partial success — keep both old + new so each consumer keeps a valid key.

  return { indexer, downloadClient }
}
