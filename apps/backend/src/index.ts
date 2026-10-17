import type { ArrServerConnector } from './lib/servers/arr/base'
import process from 'node:process'
import { getApp } from './app'
import { openDatabase } from './database/connection'
import { shutdownTelemetry } from './instrumentation'
import { registerManagedForDestination } from './lib/autoregister'
import { DownloadsConfig, getAppConfig, TorznabConfig } from './lib/config'
import { getAppEnvs } from './lib/envs'
import { FetchError } from './lib/errors/FetchError'
import { startPublicServer } from './lib/public-server'
import { ConnectorManager } from './lib/servers'
import { PROTOCOL_VERSION } from './lib/version'
import { logger } from './logger'
import { getManagementApp } from './management-app'
import { ApiKeysRepository } from './modules/api-keys/api-keys.repository'
import { ConfigService } from './modules/config/config.service'
import { DownloadsRepository } from './modules/downloads/downloads.repository'
import { DownloadsService } from './modules/downloads/downloads.service'
import { ImportWatcher } from './modules/downloads/import-watcher'
import { ManagedKeysRepository } from './modules/managed-keys/managed-keys.repository'
import { ManagedApiKeys } from './modules/managed-keys/managed-keys.service'
import { PieceHasher } from './modules/peer/piece-hasher'
import { qbCategoryForServer } from './modules/qbittorrent/qbittorrent.mapper'
import { TrafficLedger } from './modules/transfers/traffic-ledger'
import { TransfersService } from './modules/transfers/transfers.service'

function logRegistrationFailure(what: string, destName: string | undefined, err: unknown) {
  if (err instanceof FetchError) {
    logger.error({ destination: destName, status: err.extras.status, body: err.extras.body }, `Failed to register ${what}`)
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  logger.error({ destination: destName, error: message }, `Failed to register ${what}`)
}

logger.debug('Loading environment variables')
const envs = getAppEnvs()

logger.debug('Loading app config')
const { appConfig: config, raw: rawConfig } = await getAppConfig(envs)

const connectorManager = new ConnectorManager(config.servers, config.peers)
await connectorManager.initAll()

const database = await openDatabase({ appConfigPath: envs.APP_CONFIG_PATH })
const downloadsRepository = new DownloadsRepository(database.db)
const apiKeysRepository = new ApiKeysRepository(database.db)
const managedKeysRepository = new ManagedKeysRepository(database.db)

// Seed the management service from the shared raw object returned by getAppConfig
// so the service's persisted state can never diverge from the loaded runtime config.
const configService = envs.MANAGEMENT_KEY
  ? new ConfigService({ path: envs.APP_CONFIG_PATH, raw: rawConfig, connectorManager, downloadsRepository })
  : undefined

// Live-editable settings are read from the file when the management API can
// rewrite it, so edits apply without a restart; otherwise from the boot config.
function currentMaxConcurrentDownloads(): number | null {
  const raw = configService?.getRawDownloads()
  const parsed = raw ? DownloadsConfig.safeParse(raw) : undefined
  return parsed?.success ? parsed.data.maxConcurrentDownloads : config.downloads?.maxConcurrentDownloads ?? null
}

// Shared rate limits + live transfer registry.
const transfersService = new TransfersService(
  () => configService?.getBandwidth() ?? config.bandwidth,
  currentMaxConcurrentDownloads,
  { ledger: new TrafficLedger(database.sqlite) },
)
transfersService.start()

const downloadsService = config.downloads
  ? new DownloadsService(config.downloads, connectorManager, downloadsRepository, undefined, transfersService)
  : undefined

// Apply live-editable settings after every config write.
configService?.subscribe(() => {
  transfersService.refresh()
  const max = currentMaxConcurrentDownloads()
  if (downloadsService && max != null)
    downloadsService.setMaxConcurrentDownloads(max)
})

const torznabConfig = () => configService?.getTorznab() ?? TorznabConfig.parse(config.torznab ?? {})
const pieceHasher = new PieceHasher(database.sqlite)
const app = getApp(envs, config, connectorManager, { downloadsRepository, downloadsService, apiKeysRepository, managedKeysRepository, transfersService, torznabConfig, pieceHasher })
// Public server on node:http (see startPublicServer for why).
const server = startPublicServer(app.fetch, envs.PORT)

logger.info({
  version: PROTOCOL_VERSION,
  port: envs.PORT,
  configPath: envs.APP_CONFIG_PATH,
  databasePath: database.path,
  sources: connectorManager.sources.length,
  peers: connectorManager.peers.length,
  destinations: connectorManager.destinations.length,
}, 'Server listening')

// Detect *arr imports of finished downloads and flip them import_queued → imported.
// Construct this before the management app so failed imports can be retried there.
const downloadsConfig = config.downloads
const importWatcher = downloadsConfig
  ? new ImportWatcher(downloadsRepository, connectorManager, downloadsConfig.importPollIntervalMs, {
      maxAttempts: downloadsConfig.maxManualImportAttempts,
      backoffBaseMs: downloadsConfig.manualImportBackoffBaseMs,
      backoffMaxMs: downloadsConfig.manualImportBackoffMaxMs,
    }, undefined, {
      // Read per import, from the file when the management API can rewrite it, so
      // toggling it in the UI applies without a restart. completedPath still comes
      // from the boot config — it's the root every unlink is confined to.
      enabled: () => configService?.getRawDownloads()?.unlinkImportedFiles ?? downloadsConfig.unlinkImportedFiles,
      completedPath: downloadsConfig.completedPath,
    })
  : undefined

function startManagementServer() {
  if (!envs.MANAGEMENT_KEY)
    return undefined

  if (envs.MANAGEMENT_PORT === envs.PORT) {
    logger.error({ port: envs.MANAGEMENT_PORT }, 'MANAGEMENT_PORT collides with the public port; not starting the management API')
    return undefined
  }

  const managementApp = getManagementApp({
    environment: envs.ENVIRONMENT,
    managementKey: envs.MANAGEMENT_KEY,
    connectors: connectorManager,
    configService,
    downloadsRepository,
    downloadsService,
    importWatcher,
    transfersService,
    apiKeysRepository,
    tmdbApiKey: config.jack.tmdbApiKey,
  })
  const instance = Bun.serve({ port: envs.MANAGEMENT_PORT, fetch: managementApp.fetch, idleTimeout: 60 })
  logger.info({ port: instance.port }, 'Management API listening')
  return instance
}

// Module-scope so the SIGINT/SIGTERM handlers below can stop it too.
const managementServer = startManagementServer()

// Auto-register as a Torznab indexer + qBittorrent download client in each
// destination that opts in via its `autoregister` config. We register even when
// there are no peers / an empty catalog (forceSave on the *arr side), so the
// Jack indexer and client are always present and bound — they start returning
// results as soon as peers come online.
const managedApiKeys = new ManagedApiKeys(managedKeysRepository)
const jackConfig = config.jack
const downloads = config.downloads

if (!downloads) {
  logger.warn('No "downloads" config set; skipping download client auto-registration. Grabs will fail until a qBittorrent client is configured.')
}

// Registrations run one at a time: each provisions a key and commits it by
// dropping the destination's other keys, so two overlapping runs would revoke
// each other's key.
let registrationQueue: Promise<void> = Promise.resolve()

function registerDestination(dest: ArrServerConnector): Promise<void> {
  const run = registrationQueue.then(() => registerManagedForDestination(dest, {
    managedKeys: managedApiKeys,
    internalUrl: jackConfig.internalUrl,
    downloads: Boolean(downloads),
    category: qbCategoryForServer(dest.id),
    onSuccess: (kind, name, meta) => {
      if (kind === 'download client') {
        logger.info({ destination: name, downloadClientId: meta.downloadClientId }, 'Registered Jack as qBittorrent download client')
        return
      }
      logger.info({ destination: name, categories: meta.categories, downloadClientId: meta.downloadClientId }, 'Registered Jack as Torznab indexer')
    },
    onFailure: logRegistrationFailure,
  }))
  registrationQueue = run.catch(() => {})
  return run
}

const registrable = connectorManager.destinations.filter(d => d.isInitialized && d.autoRegister.enable)
for (const dest of registrable)
  await registerDestination(dest)
// Drop managed keys for destinations no longer registrable so stale keys can't authenticate.
managedApiKeys.prune(registrable.map(d => d.id))

// Re-register after a server is saved in the management UI, so a changed
// priority (or a newly added *arr) applies without a restart.
configService?.onServerSaved((id) => {
  const dest = connectorManager.destinations.find(d => d.id === id)
  if (dest?.isInitialized && dest.autoRegister.enable)
    void registerDestination(dest)
})

importWatcher?.start()

// Re-drive interrupted downloads from a prior run.
if (config.downloads && downloadsService) {
  // Active re-enqueue: resume stale `downloading` rows in place, picking up from
  // their .part files.
  const resumed = await downloadsService.resumeStaleDownloads()
  if (resumed > 0)
    logger.warn({ downloads: resumed, databasePath: database.path }, 'Re-enqueued interrupted downloads from previous Jack run')
}
else {
  // No downloads config means stale rows cannot be resumed — mark them failed.
  const failed = await downloadsRepository.reconcileStaleDownloads()
  if (failed > 0)
    logger.warn({ downloads: failed, databasePath: database.path }, 'Marked stale downloads failed (no downloads config to resume them)')
}

process.on('SIGINT', async () => {
  logger.info('SIGINT received, exiting')
  importWatcher?.stop()
  // Before database.close(): stopping flushes the traffic counts.
  transfersService.stop()
  database.close()
  server.close()
  managementServer?.stop()
  await shutdownTelemetry()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, exiting')
  importWatcher?.stop()
  // Before database.close(): stopping flushes the traffic counts.
  transfersService.stop()
  database.close()
  server.close()
  managementServer?.stop()
  await shutdownTelemetry()
  process.exit(0)
})
