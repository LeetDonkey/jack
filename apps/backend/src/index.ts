import process from 'node:process'
import { getApp } from './app'
import { openDatabase } from './database/connection'
import { shutdownTelemetry } from './instrumentation'
import { DownloadsConfig, getAppConfig, SecurityConfig, TorznabConfig } from './lib/config'
import { getAppEnvs } from './lib/envs'
import { startPublicServer } from './lib/public-server'
import { ConnectorManager } from './lib/servers'
import { generateId } from './lib/servers/base'
import { PROTOCOL_VERSION } from './lib/version'
import { logger } from './logger'
import { getManagementApp } from './management-app'
import { ApiKeyMeta } from './modules/api-keys/api-key-meta'
import { ApiKeysController } from './modules/api-keys/api-keys.controller'
import { ApiKeysRepository } from './modules/api-keys/api-keys.repository'
import { ConfigService } from './modules/config/config.service'
import { DownloadsRepository } from './modules/downloads/downloads.repository'
import { DownloadsService } from './modules/downloads/downloads.service'
import { ImportWatcher } from './modules/downloads/import-watcher'
import { PeerHealthMonitor, peerHealthNotification } from './modules/friends/peer-health'
import { IntroStore } from './modules/introductions/intro-store'
import { IntroductionsService } from './modules/introductions/introductions.service'
import { ManagedKeysRepository } from './modules/managed-keys/managed-keys.repository'
import { ManagedApiKeys } from './modules/managed-keys/managed-keys.service'
import { buildDailySummary } from './modules/notifications/daily-summary'
import { NotificationsService } from './modules/notifications/notifications.service'
import { PieceHasher } from './modules/peer/piece-hasher'
import { RegistrationService } from './modules/registration/registration.service'
import { BanList } from './modules/security/ban-list'
import { pendingRestart } from './modules/status/restart-pending'
import { localDay, TrafficLedger } from './modules/transfers/traffic-ledger'
import { followDownloadsPause } from './modules/transfers/transfer-pauses'
import { TransfersService } from './modules/transfers/transfers.service'

logger.debug('Loading environment variables')
const envs = getAppEnvs()

logger.debug('Loading app config')
const { appConfig: config, raw: rawConfig } = await getAppConfig(envs)
// What this process runs with, refs unresolved: settings saved later are compared
// against it to tell the user which ones wait for a restart.
const bootRaw = structuredClone(rawConfig)
const bootedAt = new Date().toISOString()

const connectorManager = new ConnectorManager(config.servers, config.peers)
await connectorManager.initAll()

const database = await openDatabase({ appConfigPath: envs.APP_CONFIG_PATH })
const downloadsRepository = new DownloadsRepository(database.db)
const apiKeysRepository = new ApiKeysRepository(database.db)
// Last use and peer link per API key, for the friends view (fork table).
const apiKeyMeta = new ApiKeyMeta(database.sqlite)
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

function currentInternalUrl(): string {
  return configService?.getInternalUrl() ?? config.jack.internalUrl
}

// Registers jack in every auto-register Radarr/Sonarr and asks them to test it.
// Built before the public app, which reports each *arr's contact to it.
const managedApiKeys = new ManagedApiKeys(managedKeysRepository)
const registrations = new RegistrationService({
  managedKeys: managedApiKeys,
  destinations: () => connectorManager.destinations,
  internalUrl: currentInternalUrl,
  downloads: () => Boolean(configService ? configService.getRawDownloads() : config.downloads),
  // /api/v2 and the download queue exist only if downloads were set at boot.
  downloadsActive: () => Boolean(config.downloads),
})
// Re-register after a saved server (a changed priority or a newly added *arr),
// a new internal URL, or downloads turned on, so none of them needs a restart.
// Wired before the management API starts, so no save goes unregistered.
if (configService)
  registrations.followConfig(configService)

// Shared rate limits + live transfer registry.
const transfersService = new TransfersService(
  () => configService?.getBandwidth() ?? config.bandwidth,
  currentMaxConcurrentDownloads,
  {
    ledger: new TrafficLedger(database.sqlite),
    // Read live, like the bandwidth block: pausing is a config write.
    downloadsPausedUntil: () => configService ? configService.getRawDownloads()?.pausedUntil : config.downloads?.pausedUntil,
  },
)
transfersService.start()

const downloadsService = config.downloads
  ? new DownloadsService(config.downloads, connectorManager, downloadsRepository, undefined, transfersService)
  : undefined

// Paused downloads take no slot until the pause ends (also at boot, for a pause
// saved before a restart); running transfers finish.
if (downloadsService)
  followDownloadsPause(transfersService, downloadsService)

// Apply live-editable settings after every config write.
configService?.subscribe(() => {
  transfersService.refresh()
  const max = currentMaxConcurrentDownloads()
  if (downloadsService && max != null)
    downloadsService.setMaxConcurrentDownloads(max)
})

const torznabConfig = () => configService?.getTorznab() ?? TorznabConfig.parse(config.torznab ?? {})
const pieceHasher = new PieceHasher(database.sqlite)

// fail2ban for the public port, read live from the config.
const securityConfig = () => configService?.getSecurity() ?? SecurityConfig.parse(config.security ?? {})
const bans = new BanList(database.sqlite, securityConfig)

// Meeting friends of friends. Needs the management API's config service, since
// accepting adds a peer to the config file.
const apiKeysController = new ApiKeysController(apiKeysRepository, { meta: apiKeyMeta })
const introductions = configService
  ? new IntroductionsService({
      store: new IntroStore(database.sqlite),
      discovery: () => configService.getDiscovery(),
      external: () => {
        try {
          return configService.getResolvedExternalJack()
        }
        catch {
          return null
        }
      },
      peers: () => connectorManager.peers,
      issueKey: (name, description) => {
        const created = apiKeysController.create({ name, description }, { origin: 'introduction' })
        return { id: created.id, key: created.key }
      },
      apiKeyName: id => apiKeysRepository.get(id)?.name ?? null,
      addPeer: peer => configService.addPeer(peer, { force: true }),
      linkKey: (apiKeyId, peerUrl) => apiKeyMeta.setPeer(apiKeyId, generateId(peerUrl)),
      keyPeerId: apiKeyId => apiKeyMeta.get(apiKeyId).peerId,
    })
  : undefined
introductions?.start()
const app = getApp(envs, config, connectorManager, {
  downloadsRepository,
  downloadsService,
  apiKeysRepository,
  managedKeysRepository,
  transfersService,
  torznabConfig,
  pieceHasher,
  introductions,
  bans,
  trustedProxies: () => securityConfig().trustedProxies,
  arrAccess: () => {
    const security = securityConfig()
    return { lanOnly: security.lanOnlyArrApis, alsoAllowed: security.arrApiAlsoAllowed, trustedProxies: security.trustedProxies }
  },
  publicOpenApi: () => securityConfig().publicOpenApi,
  internalUrl: currentInternalUrl,
  onArrContact: id => registrations.recordContact(id),
  onPeerKeyUsed: id => apiKeyMeta.touch(id),
})
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

// Notifications (webhooks) and peer reachability, read live from the config.
const notificationsConfig = () => configService?.getNotifications() ?? config.notifications
const notifications = new NotificationsService(notificationsConfig)
const peerHealth = new PeerHealthMonitor(
  () => connectorManager.peers,
  () => (notificationsConfig()?.peerOfflineMinutes ?? 60) * 60_000,
)
peerHealth.onEvent((event) => {
  void notifications.send(peerHealthNotification(event))
})
downloadsService?.onDownloadFailed((record, error) => {
  void notifications.send({ event: 'download-failed', title: `Download failed: ${record.filename}`, message: `From ${record.peerName}: ${error}` })
})
notifications.startDailySummary(() => buildDailySummary(
  transfersService.ledger?.totalsSince(localDay(new Date())) ?? [],
  downloadsRepository.list(),
  new Date(),
))
// A saved peer is checked at once, so its status is current without waiting for
// the next 5-minute round. Keys linked to it and the identity it reported follow
// a changed url (new id); a removed peer's identity is forgotten.
configService?.onPeerSaved((id, previousId) => {
  if (previousId && previousId !== id) {
    apiKeyMeta.reassignPeer(previousId, id)
    introductions?.movePeer(previousId, id)
  }
  const peer = connectorManager.peers.find(p => p.id === id)
  if (peer)
    void peerHealth.check(peer)
})
configService?.onPeerRemoved(id => introductions?.forgetPeer(id))
bans.onBan((ban) => {
  void notifications.send({ event: 'ip-banned', title: `Banned ${ban.ip}`, message: `${ban.failures} failed attempts on the public port (last: ${ban.reason}). Banned until ${new Date(ban.bannedUntil).toLocaleString('en-GB')}. Lift it under Settings -> Sharing -> Security.` })
})
peerHealth.start()

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
    apiKeyMeta,
    tmdbApiKey: config.jack.tmdbApiKey,
    peerHealth,
    notifications,
    introductions,
    bans,
    registrations,
    system: () => ({
      bootedAt,
      restartPending: configService ? pendingRestart(bootRaw, configService.getRaw()) : [],
    }),
    completedPath: () => configService ? configService.getRawDownloads()?.completedPath ?? null : config.downloads?.completedPath ?? null,
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
// results as soon as peers come online. Without downloads nothing is registered
// (see registerManagedForDestination).
if (!config.downloads)
  logger.warn('Downloads are off, so jack did not add its indexer or download client to Radarr/Sonarr. Turn on Downloads in Settings, then restart the jack container.')

// Keep managed keys only for destinations jack may register in, reachable or
// not, so a stale key of any other server can't authenticate.
managedApiKeys.prune(connectorManager.destinations.filter(d => registrations.isRegistrable(d)).map(d => d.id))

// Not awaited: each registration also waits for the *arr to test jack, which can
// take its full timeout when the *arr can't reach jack. Results show on the
// overview as they come in.
void registrations.registerAll()

// Destinations that were down at boot: retry them, and register once they're up.
registrations.start(subscriber => connectorManager.subscribe(subscriber))

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
  registrations.stop()
  peerHealth.stop()
  notifications.stop()
  introductions?.stop()
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
  registrations.stop()
  peerHealth.stop()
  notifications.stop()
  introductions?.stop()
  // Before database.close(): stopping flushes the traffic counts.
  transfersService.stop()
  database.close()
  server.close()
  managementServer?.stop()
  await shutdownTelemetry()
  process.exit(0)
})
