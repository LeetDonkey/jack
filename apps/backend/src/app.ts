import type { AppConfig, TorznabConfig } from './lib/config'
import type { Envs } from './lib/envs'
import type { ConnectorManager } from './lib/servers'
import type { ApiKeysRepository } from './modules/api-keys/api-keys.repository'
import type { DownloadsRepository } from './modules/downloads/downloads.repository'
import type { DownloadsService } from './modules/downloads/downloads.service'
import type { IntroductionsService } from './modules/introductions/introductions.service'
import type { ManagedKeysRepository } from './modules/managed-keys/managed-keys.repository'
import type { PieceHasher } from './modules/peer/piece-hasher'
import type { BanList } from './modules/security/ban-list'
import type { ArrAccess } from './modules/security/lan-guard'
import type { TransfersService } from './modules/transfers/transfers.service'
import { httpInstrumentationMiddleware } from '@hono/otel'
import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import { secureHeaders } from 'hono/secure-headers'
import z from 'zod'
import { buildIdentity } from './lib/build'
import { getAppEnvs, isOtelEnabled } from './lib/envs'
import { peerDocumentation } from './lib/openapi'
import { PROTOCOL_VERSION } from './lib/version'
import { handleError } from './middleware/handle-error'
import { logRequests } from './middleware/log-requests'
import { requireApiKey } from './middleware/require-auth'
import { getIntroPeerRouter } from './modules/introductions/introductions.router'
import { PeerController } from './modules/peer/peer.controller'
import { getPeerRouter } from './modules/peer/peer.router'
import { QbittorrentController } from './modules/qbittorrent/qbittorrent.controller'
import { getQbittorrentRouter } from './modules/qbittorrent/qbittorrent.router'
import { banGuard } from './modules/security/ban-guard'
import { lanGuard } from './modules/security/lan-guard'
import { getDownloadRouter } from './modules/torznab/download.router'
import { TorznabController } from './modules/torznab/torznab.controller'
import { getTorznabRouter } from './modules/torznab/torznab.router'

interface AppServices {
  // Both auth repositories are required: this app mounts the peer scope (api_key)
  // and the *arr scope (managed_key), and each scope must be able to validate its
  // own key class (see require-auth.ts).
  apiKeysRepository: ApiKeysRepository
  managedKeysRepository: ManagedKeysRepository
  downloadsRepository?: DownloadsRepository
  downloadsService?: DownloadsService
  transfersService?: TransfersService
  /** Live torznab feed settings; defaults when absent. */
  torznabConfig?: () => TorznabConfig
  /** Piece hashes of shared files, for peers that verify or compare them. */
  pieceHasher?: PieceHasher
  /** Friends-of-friends introductions (peer side). */
  introductions?: IntroductionsService
  /** Temporary bans for addresses that keep failing authentication (fail2ban). */
  bans?: BanList
  trustedProxies?: () => readonly string[] | null | undefined
  /** Who may use /torznab and /api/v2, read per request. Unset: everyone (tests). */
  arrAccess?: () => ArrAccess
  /** Whether /openapi.json answers on the public port, read per request. Unset: yes. */
  publicOpenApi?: () => boolean
  /** jack.internalUrl as stored now; defaults to the boot config. */
  internalUrl?: () => string
  /** Called with the destination id whenever its Radarr/Sonarr authenticates, and on which API. */
  onArrContact?: (destinationId: string, api: 'torznab' | 'qbittorrent') => void
  /** Called with the api_key id whenever a friend's jack authenticates with it (/handshake, /peer/*). */
  onPeerKeyUsed?: (apiKeyId: number) => void
}

// This is the external surface, gated per audience rather than by one global key:
//  - peers (other Jacks) reach /handshake + /peer/* with regular api_keys;
//  - the operator's Radarr/Sonarr reach /torznab/* (managed key) and /api/v2/*
//    (qBittorrent, own SID-cookie auth);
//  - admin/connector/download views live ONLY on the management API.
// Only the live `servers`/`peers` getters are used here, so accept the structural
// shape a real `ConnectorManager` satisfies — this also lets tests pass a lightweight
// `{ servers, peers }` object.
export function getApp(envs: Envs, config: AppConfig, connManager: { servers: ConnectorManager['servers'], peers: ConnectorManager['peers'] }, services: AppServices) {
  const app = new Hono()

  const peerController = new PeerController(() => connManager.servers)

  app.use('*', secureHeaders())
  // Before every route: refuse banned addresses, count failed authentication.
  if (services.bans)
    app.use('*', banGuard(services.bans, services.trustedProxies ?? (() => undefined)))

  // Health check — unauthenticated, used by Docker/orchestrators.
  app.get('/ping', describeRoute({
    tags: ['System'],
    summary: 'Health check',
    description: 'Unauthenticated liveness probe for Docker/orchestrators.',
    responses: {
      200: { description: 'The server is up', content: { 'application/json': { schema: resolver(z.object({ status: z.literal('OK') })) } } },
    },
  }), c => c.json({ status: 'OK' }, 200))

  // Wrap every request in an OpenTelemetry server span (method, route, status,
  // duration, ...). Outermost so the span is active for the rest of the chain —
  // including the request log below, which then carries the trace/span ids.
  // Only mounted when tracing is enabled to avoid the per-request overhead.
  if (isOtelEnabled(getAppEnvs())) {
    app.use('*', httpInstrumentationMiddleware())
  }

  // Enrich the active request span with HTTP details, then emit a compact
  // request-completed log without headers, query params, or bodies.
  app.use('*', logRequests)

  // qBittorrent WebUI API -- Radarr/Sonarr poll us as a download client. It uses its
  // own SID-cookie auth (/api/v2/auth/login), which is itself scoped to master +
  // managed keys (see qbittorrent.controller), so it's mounted outside the api-key
  // scopes below.
  if (config.downloads && services.downloadsRepository) {
    const transfers = services.transfersService
    const qbController = new QbittorrentController({
      apiKey: config.jack.apiKey ?? '',
      completedPath: config.downloads.completedPath,
      get servers() { return connManager.servers },
      repository: services.downloadsRepository,
      downloadsService: services.downloadsService,
      managedKeysRepository: services.managedKeysRepository,
      onContact: id => services.onArrContact?.(id, 'qbittorrent'),
      // Real speed and time left for Radarr/Sonarr's queue.
      liveTransfers: transfers ? () => transfers.monitor.list() : undefined,
    })
    if (services.arrAccess)
      app.use('/api/v2/*', lanGuard(services.arrAccess))
    app.route('/api/v2', getQbittorrentRouter(qbController))
  }

  const masterKey = config.jack.apiKey ?? ''
  // Peer scope: other Jacks present regular api_keys. *arr scope: the operator's
  // Radarr/Sonarr present the managed key Jack registered with them.
  const peerAuth = requireApiKey(masterKey, { type: 'api_key', repository: services.apiKeysRepository, onAuthenticated: services.onPeerKeyUsed })
  const arrAuth = requireApiKey(masterKey, { type: 'managed_key', repository: services.managedKeysRepository, onAuthenticated: id => services.onArrContact?.(id, 'torznab') })

  // Peer handshake — other Jacks probe this at init to read our identity and
  // protocol version, then check it against their minimum compatible version.
  // Authenticated so a bad API key still fails loudly at connect time, unlike the
  // unauthenticated /ping health check.
  // `build` is optional: older jacks and builds without a revision leave it out,
  // and peers ignore fields they don't know.
  const build = buildIdentity()
  const handshake = { name: 'jack', version: PROTOCOL_VERSION, ...(build.revision ? { build } : {}) }
  app.get('/handshake', describeRoute({
    tags: ['System'],
    summary: 'Peer handshake',
    description: 'Identity and protocol version. Peers probe this at init and check the version against their minimum compatible version. `build` (`{ revision, buildDate }`, the git commit and build time of the image) is present only when the image was built with a revision.',
    security: [{ 'X-Api-Key': [] }],
    responses: {
      200: { description: 'Identity and protocol version', content: { 'application/json': { schema: resolver(z.object({
        name: z.string(),
        version: z.string(),
        build: z.object({ revision: z.string().nullable(), buildDate: z.string().nullable() }).optional(),
      })) } } },
    },
  }), peerAuth, c => c.json(handshake, 200))

  // Peer API — other Jacks talk to us to search and download. Serves empty results
  // when there's no local source to read from.
  app.use('/peer/*', peerAuth)
  if (services.introductions)
    app.route('/peer/intro', getIntroPeerRouter(services.introductions))
  app.route('/peer', getPeerRouter(peerController, services.transfersService, services.pieceHasher))

  // Torznab API — the operator's Radarr/Sonarr search through us and grab via the
  // download router. Returns empty results when there are no peers to fan out to.
  const torznabController = new TorznabController(
    () => connManager.peers,
    services.internalUrl ?? (() => config.jack.internalUrl),
    services.torznabConfig,
    id => connManager.servers.find(s => s.id === id && s.canDestination),
  )
  if (services.arrAccess)
    app.use('/torznab/*', lanGuard(services.arrAccess))
  app.use('/torznab/*', arrAuth)
  app.route('/torznab', getTorznabRouter(torznabController))
  app.route('/torznab', getDownloadRouter(() => connManager.peers))

  // Live OpenAPI spec for this app. Unauthenticated like /ping: it exposes
  // route shapes only (the same ones documented on the public website), never
  // config values or keys. Off unless security.publicOpenApi is on.
  const openApi = openAPIRouteHandler(app, { documentation: peerDocumentation })
  app.get('/openapi.json', async (c, next) => {
    if (!(services.publicOpenApi?.() ?? true))
      return c.json({ error: 'Not found' }, 404)
    await next()
  }, openApi)

  // Peer-facing app: error responses are opaque (see handle-error.ts).
  app.onError(handleError(envs.ENVIRONMENT))

  return app
}
