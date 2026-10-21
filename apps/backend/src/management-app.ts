import type { VersionInfo } from './lib/build'
import type { ConnectorManager } from './lib/servers'
import type { ApiKeyMeta } from './modules/api-keys/api-key-meta'
import type { ApiKeysRepository } from './modules/api-keys/api-keys.repository'
import type { ConfigService } from './modules/config/config.service'
import type { DownloadsRepository } from './modules/downloads/downloads.repository'
import type { DownloadsService } from './modules/downloads/downloads.service'
import type { ImportWatcher } from './modules/downloads/import-watcher'
import type { PeerHealthMonitor } from './modules/friends/peer-health'
import type { IntroductionsService } from './modules/introductions/introductions.service'
import type { NotificationsService } from './modules/notifications/notifications.service'
import type { RegistrationService } from './modules/registration/registration.service'
import type { BanList } from './modules/security/ban-list'
import type { SystemStatus } from './modules/status/status.controller'
import type { SystemNotices } from './modules/status/system-notices'
import type { TransfersService } from './modules/transfers/transfers.service'
import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import { secureHeaders } from 'hono/secure-headers'
import z from 'zod'
import { versionInfo } from './lib/build'
import { managementDocumentation } from './lib/openapi'
import { TmdbClient } from './lib/tmdb/client'
import { handleError } from './middleware/handle-error'
import { requireManagementKey } from './middleware/require-management-key'
import { ApiKeysController } from './modules/api-keys/api-keys.controller'
import { getApiKeysRouter } from './modules/api-keys/api-keys.router'
import { CatalogController } from './modules/catalog/catalog.controller'
import { getCatalogRouter } from './modules/catalog/catalog.router'
import { ConfigController } from './modules/config/config.controller'
import { getConfigRouter } from './modules/config/config.router'
import { getDiagnosticsRouter } from './modules/diagnostics/diagnostics.router'
import { FolderCheck } from './modules/diagnostics/folder-check'
import { DownloadsManagementController } from './modules/downloads/downloads.controller'
import { getDownloadsManagementRouter } from './modules/downloads/downloads.router'
import { getFriendsRouter } from './modules/friends/friends.router'
import { getIntroductionsRouter } from './modules/introductions/introductions.router'
import { logHub } from './modules/logging/log-store'
import { LogsController } from './modules/logging/logs.controller'
import { getLogsRouter } from './modules/logging/logs.router'
import { getNotificationsRouter } from './modules/notifications/notifications.router'
import { QuickLinksController } from './modules/quick-links/quick-links.controller'
import { getQuickLinksRouter } from './modules/quick-links/quick-links.router'
import { getSecurityRouter } from './modules/security/security.router'
import { StatusController } from './modules/status/status.controller'
import { getStatusRouter } from './modules/status/status.router'
import { BuildIdentitySchema } from './modules/status/status.schema'
import { getSystemRouter } from './modules/status/system.router'
import { configSecrets } from './modules/support/support-bundle'
import { getSupportRouter } from './modules/support/support.router'
import { TransferPauses } from './modules/transfers/transfer-pauses'
import { getTransfersRouter } from './modules/transfers/transfers.router'

export function getManagementApp(params: {
  environment: string
  managementKey: string
  // The live manager (its `servers`/`peers` getters are read per request).
  connectors: { servers: ConnectorManager['servers'], peers: ConnectorManager['peers'], subscribe?: ConnectorManager['subscribe'] }
  configService?: ConfigService
  downloadsRepository?: DownloadsRepository
  downloadsService?: DownloadsService
  importWatcher?: ImportWatcher
  transfersService?: TransfersService
  apiKeysRepository?: ApiKeysRepository
  /** Last use and peer links of API keys (fork table api_key_meta). */
  apiKeyMeta?: ApiKeyMeta
  tmdbApiKey?: string
  peerHealth?: PeerHealthMonitor
  notifications?: NotificationsService
  introductions?: IntroductionsService
  bans?: BanList
  /** Registration results per server, plus POST /config/servers/:id/register. */
  registrations?: RegistrationService
  /** How long server saves and POST /config/servers/:id/register wait for the registration (default 25 s). */
  registrationWaitMs?: number
  /** overview.system: boot time, settings waiting for a restart and notices. */
  system?: () => SystemStatus
  /** Dismisses overview.system.notices (POST /system/notices/:id/dismiss); the overview stream follows it. */
  notices?: Pick<SystemNotices, 'dismiss' | 'subscribe'>
  /** GET /version; defaults to this process's build (lib/build.ts). */
  version?: () => VersionInfo
  /** downloads.completedPath as stored now, for the folder check; null when downloads are off. */
  completedPath?: () => string | null
}) {
  const app = new Hono()

  app.use('*', secureHeaders())

  // Live OpenAPI spec for this app, registered ahead of the key guard: it
  // exposes route shapes only (the same ones documented on the public website),
  // never config values or keys.
  app.get('/openapi.json', openAPIRouteHandler(app, { documentation: managementDocumentation }))

  // The rest of the surface is key-guarded; no other route is reachable without it.
  app.use('*', requireManagementKey(params.managementKey))

  // Cheap key-guarded probe for the UI's BFF: reaching it 200 proves the key is
  // valid and the management API is up; a connection error proves it's disabled.
  app.get('/ping', describeRoute({
    tags: ['System'],
    summary: 'Health check',
    description: 'Key-guarded probe: a 200 proves the key is valid and the management API is up.',
    security: [{ 'X-Management-Key': [] }],
    responses: {
      200: { description: 'The management API is up and the key is valid', content: { 'application/json': { schema: resolver(z.object({ ok: z.literal(true) })) } } },
    },
  }), c => c.json({ ok: true }))

  const version = params.version ?? (() => versionInfo())
  app.get('/version', describeRoute({
    tags: ['System'],
    summary: 'jack version and build',
    description: '`version` is the peer-protocol version (the same on every build). `revision` is the git commit the image was built from and `buildDate` when (ISO 8601); both are null for an image built without the REVISION and BUILD_DATE build args, or when jack runs from source.',
    security: [{ 'X-Management-Key': [] }],
    responses: {
      200: { description: 'Version and build', content: { 'application/json': { schema: resolver(BuildIdentitySchema.extend({ version: z.string() })) } } },
    },
  }), c => c.json(version()))

  // Whether catalog requests can start downloads now: the queue and /api/v2 run
  // only when downloads were set up at boot (see restartPending).
  const downloadsInactiveReason = () => {
    const configured = params.configService ? Boolean(params.configService.getRawDownloads()) : Boolean(params.downloadsService)
    if (!configured)
      return 'off' as const
    return params.downloadsService ? null : 'restartPending' as const
  }

  const configController = new ConfigController(params.connectors, params.configService, params.registrations, { registrationWaitMs: params.registrationWaitMs })
  app.route('/config', getConfigRouter(configController))

  const configService = params.configService
  const notices = params.notices
  const statusController = new StatusController(params.connectors, params.downloadsRepository, {
    registrations: params.registrations,
    system: params.system,
    health: params.peerHealth,
    downloadPhases: params.downloadsService,
    traffic: params.transfersService?.ledger,
    // restartPending and the notices change with every config save, and a notice with a dismiss.
    subscriptions: [
      ...(configService ? [(subscriber: () => void) => configService.subscribe(subscriber)] : []),
      ...(notices ? [(subscriber: () => void) => notices.subscribe(subscriber)] : []),
    ],
  })
  app.route('/', getStatusRouter(statusController))
  app.route('/system', getSystemRouter(notices))

  app.route('/downloads', getDownloadsManagementRouter(new DownloadsManagementController(
    params.downloadsRepository,
    params.downloadsService,
    params.importWatcher,
  )))

  // Logs read from the shared LogHub singleton the logger writes to (same module
  // instance), so this exposes the running process's own logs.
  app.route('/logs', getLogsRouter(new LogsController(logHub)))

  if (params.transfersService) {
    const pauses = configService ? new TransferPauses(configService, params.transfersService) : undefined
    app.route('/transfers', getTransfersRouter(params.transfersService, pauses))
  }

  app.route('/diagnostics', getDiagnosticsRouter(new FolderCheck({
    servers: () => params.connectors.servers,
    completedPath: params.completedPath ?? (() => null),
  })))

  app.route('/support-bundle', getSupportRouter({
    version,
    internalUrl: () => configService?.getInternalUrl() ?? null,
    externalConfigured: () => Boolean(configService?.getRaw().jack?.external),
    downloads: () => ({ configured: downloadsInactiveReason() !== 'off', active: downloadsInactiveReason() === null }),
    restartPending: () => params.system?.().restartPending ?? [],
    paused: params.transfersService ? () => ({ uploads: params.transfersService!.pauseState('uploads'), downloads: params.transfersService!.pauseState('downloads') }) : undefined,
    servers: () => params.connectors.servers,
    registrations: params.registrations,
    peers: () => params.connectors.peers,
    health: params.peerHealth,
    apiKeys: params.apiKeysRepository,
    keyMeta: params.apiKeyMeta,
    logs: (lines, keep) => logHub.backfill({ lines, keep }),
    secrets: () => [params.managementKey, ...configSecrets(configService?.getRaw() ?? null)],
  }))

  if (params.peerHealth) {
    app.route('/friends', getFriendsRouter({
      health: params.peerHealth,
      ledger: params.transfersService?.ledger,
      monitor: params.transfersService?.monitor,
      apiKeys: params.apiKeysRepository,
      keyMeta: params.apiKeyMeta,
      identities: params.introductions,
      bandwidth: () => params.configService?.getBandwidth(),
    }))
  }

  if (params.notifications)
    app.route('/notifications', getNotificationsRouter(params.notifications))

  if (params.introductions)
    app.route('/introductions', getIntroductionsRouter(params.introductions))

  if (params.bans)
    app.route('/security', getSecurityRouter(params.bans))

  const tmdbClient = params.tmdbApiKey ? new TmdbClient(params.tmdbApiKey) : undefined
  const catalogController = new CatalogController(params.connectors, tmdbClient, params.downloadsService, undefined, {
    health: params.peerHealth,
    downloadsInactiveReason,
  })
  app.route('/catalog', getCatalogRouter(catalogController))

  if (params.apiKeysRepository) {
    const apiKeysController = new ApiKeysController(params.apiKeysRepository, {
      meta: params.apiKeyMeta,
      bindings: params.introductions,
      peerExists: id => params.connectors.peers.some(p => p.id === id),
    })
    app.route('/api-keys', getApiKeysRouter(apiKeysController))

    if (params.configService)
      app.route('/quick-links', getQuickLinksRouter(new QuickLinksController(params.configService, apiKeysController)))
  }

  // The management API is key-guarded and serves the admin UI, so it exposes
  // full error detail. The peer-facing app (app.ts) leaves this off and returns
  // opaque errors instead.
  app.onError(handleError(params.environment, { exposeDetails: true }))

  return app
}
