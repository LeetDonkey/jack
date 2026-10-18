import type { ConfigController } from './config.controller'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { z } from 'zod'
import { RawBandwidthConfig, RawDiscoveryConfig, RawDownloadsConfig, RawExternalJackConfig, RawJackConfigPatch, RawNotificationsConfig, RawPeerConfig, RawSecurityConfig, RawServerConfig, RawTorznabConfig } from '../../lib/config'
import { streamSnapshots } from '../../lib/sse'
import { validator as zValidator } from '../../lib/validation'
import { RegisterResponseSchema, ServerSaveResponseSchema } from '../registration/registration.schema'
import { ConfigListSchema, ServerListSchema } from './config.schema'

const idParam = z.object({ id: z.string().min(1) })

const ExternalCheckResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  error: z.string().nullable(),
  url: z.string(),
})

function configDoc(summary: string, description?: string, status = 200, schema?: z.ZodType, errors: Record<number, string> = {}) {
  return describeRoute({
    tags: ['Config'],
    summary,
    description,
    security: [{ 'X-Management-Key': [] }],
    responses: {
      [status]: { description: 'Success', content: { 'application/json': schema ? { schema: resolver(schema) } : {} } },
      ...Object.fromEntries(Object.entries(errors).map(([code, text]) => [code, { description: text }])),
    },
  })
}

const VALIDATION_DOC = 'A body that fails validation answers 400 with `{ ok: false, error: { code: "VALIDATION_ERROR", message, field, issues } }`: `field` is the dotted path of the first offending field (null for the body as a whole), `message` describes it, and `issues` lists every problem as `{ field, message }`.'

const PEER_ERRORS = {
  400: 'The body fails validation (see the description for the format)',
  409: 'Another peer has this url or name',
  502: 'The peer failed its handshake. `error.reason` says why: `timeout`, `dns`, `refused`, `tls`, `unauthorized`, `forbidden`, `incompatible`, `unavailable` or `unknown`; `error.upstreamStatus` is the HTTP status the peer or its proxy answered with, or null',
}

const PEER_SAVE_DOC = `When the handshake fails the route answers 502 and saves nothing. \`error.reason\` classifies the failure: \`timeout\` (no answer in time), \`dns\` (the host name doesn't resolve), \`refused\` (nothing accepts connections there, or the host is unreachable), \`tls\` (certificate rejected), \`unauthorized\` (the peer rejected the key, 401), \`forbidden\` (the peer refused us, 403, for example a ban), \`incompatible\` (no handshake route or a version too old), \`unavailable\` (a 5xx answer or a cut connection) or \`unknown\`. \`error.upstreamStatus\` is the peer's HTTP status, or null when it didn't answer. ${VALIDATION_DOC} After a save jack checks the peer's health at once, so \`health\` on \`/overview\` and \`/friends\` is current.`

// GET /config, /config/peers and /config/servers hand the stored credentials to
// the edit forms (see ConfigController.withSecrets).
const SECRETS_DOC = 'Each server and peer carries its `apiKey` and `headers` as stored in the config file, so the edit forms can show them: an `{ env }` or `{ file }` reference stays a reference, and a value written into the file is returned as it is. Nothing is redacted; `GET /support-bundle` is the redacted summary to share.'

const SERVER_FIELDS_DOC = 'Each server also carries `registration` (what jack registered in it at the last registration this boot, and whether the *arr\'s Test of jack\'s download client and indexer passed) and `lastContactAt` (when that *arr last authenticated with the key jack gave it). Both are null until known; `registration` stays null for a server jack doesn\'t register itself in.'

const SERVER_SAVE_DOC = 'Answers once jack has registered itself in the server (indexer and download client) and the *arr has tested both, with the result as `registration`. That usually takes a second or two; it waits behind any registration already running, and a test the *arr can\'t finish takes up to 45 seconds. After 25 seconds the route answers with `registration: null` and `registrationPending: true`, and the result arrives on `/config/stream` and `/overview/stream`. `registration` is also null when the server isn\'t an auto-register destination.'

export function getConfigRouter(controller: ConfigController) {
  const app = new Hono()

  app.get('/', configDoc('Get the full config', `The configured servers and peers. ${SECRETS_DOC} ${SERVER_FIELDS_DOC}`, 200, ConfigListSchema), c => c.json(controller.listConfig()))
  app.get('/peers', configDoc('List configured peers', SECRETS_DOC), c => c.json(controller.listPeers()))
  app.get('/servers', configDoc('List configured servers', `${SECRETS_DOC} ${SERVER_FIELDS_DOC}`, 200, ServerListSchema), c => c.json(controller.listServers()))
  app.get('/jack', configDoc('Get the jack block'), c => c.json(controller.getJack()))
  app.get('/downloads', configDoc('Get the downloads block', 'The persisted downloads config, or null when downloads are not configured.'), c => c.json(controller.getDownloads()))
  app.get('/bandwidth', configDoc('Get the bandwidth block', 'Combined rate limits, the upload slot limit and the weekly schedule, with defaults applied. Null when bandwidth is not configured.'), c => c.json(controller.getBandwidth()))
  app.get('/torznab', configDoc('Get the torznab block', 'What the Torznab RSS feed offers: releases peers added within rssMaxAgeDays, newest first, at most rssMaxItems. Defaults apply when the block is absent.'), c => c.json(controller.getTorznab()))
  app.get('/notifications', configDoc('Get the notifications block', 'Webhooks and which events to send, as stored: webhook URLs keep their {env}/{file} references.'), c => c.json(controller.getNotifications()))
  app.get('/discovery', configDoc('Get the discovery block', 'Public name and whether friends of friends may find you and whether you introduce your friends to each other, with defaults applied.'), c => c.json(controller.getDiscovery()))
  app.get('/security', configDoc('Get the security block', 'How the public port protects itself, with defaults applied: temporary bans (banEnabled, maxFailures, windowMinutes, banMinutes, trustedProxies, neverBan), the Torznab and qBittorrent APIs only for the LAN (lanOnlyArrApis, arrApiAlsoAllowed), and whether /openapi.json is served (publicOpenApi).'), c => c.json(controller.getSecurity()))
  app.get('/stream', describeRoute({
    tags: ['Config'],
    summary: 'Stream connector config',
    description: 'Server-Sent Events stream with an initial connector snapshot and immediate updates when connector state, the config file or a server\'s registration changes.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live connector snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => controller.listConfig(), subscriber => controller.subscribe(subscriber)))

  // Mutation routes only exist when a ConfigService is wired in. Without one, these
  // paths are simply unregistered → 404 (rather than a 500 from an unconfigured call).
  if (controller.canMutate) {
    // `?force=true` persists the peer even if its handshake fails — it stays
    // resident and auto-retries lazily, instead of aborting + rolling back.
    app.post('/peers', configDoc('Add a peer', `Persists a new peer and connects to it. \`?force=true\` keeps the peer even if its handshake fails; jack keeps checking it every 5 minutes and connects once it answers. ${PEER_SAVE_DOC}`, 201, undefined, PEER_ERRORS), zValidator('json', RawPeerConfig), async (c) => {
      const force = c.req.query('force') === 'true'
      return c.json(await controller.addPeer(c.req.valid('json'), { force }), 201)
    })

    app.delete('/peers/:id', configDoc('Remove a peer'), zValidator('param', idParam), async (c) => {
      return c.json(await controller.removePeer(c.req.valid('param').id))
    })

    app.patch('/peers/:id', configDoc('Update a peer', `Persists changes and reconnects. \`?force=true\` keeps the peer even if its handshake fails. A changed url gives the peer a new id; API keys linked to the old id follow it. ${PEER_SAVE_DOC}`, 200, undefined, { ...PEER_ERRORS, 404: 'No peer with this id' }), zValidator('param', idParam), zValidator('json', RawPeerConfig), async (c) => {
      const force = c.req.query('force') === 'true'
      return c.json(await controller.updatePeer(c.req.valid('param').id, c.req.valid('json'), { force }))
    })

    app.post('/servers', configDoc('Add a Radarr/Sonarr server', `Persists the server after a connection check. ${SERVER_SAVE_DOC}`, 201, ServerSaveResponseSchema), zValidator('json', RawServerConfig), async (c) => {
      return c.json(await controller.addServer(c.req.valid('json')), 201)
    })

    app.delete('/servers/:id', configDoc('Remove a server'), zValidator('param', idParam), async (c) => {
      return c.json(await controller.removeServer(c.req.valid('param').id))
    })

    app.patch('/servers/:id', configDoc('Update a server', `Persists the changes after a connection check. ${SERVER_SAVE_DOC}`, 200, ServerSaveResponseSchema), zValidator('param', idParam), zValidator('json', RawServerConfig), async (c) => {
      return c.json(await controller.updateServer(c.req.valid('param').id, c.req.valid('json')))
    })

    // The internal URL is read per registration and per Torznab feed, so it applies
    // at once; the keys are read at boot. No connectivity check.
    app.patch('/jack', configDoc('Update the jack block', 'Merges the given fields into the stored jack block: an absent key keeps its value, `null` removes it (`internalUrl` can\'t be removed). `external` is kept unless the body sets it. A new `internalUrl` applies immediately: jack registers the new address in every auto-register Radarr/Sonarr in the background, and `registration` on each server shows the result. `apiKey` and `tmdbApiKey` take effect on next boot.'), zValidator('json', RawJackConfigPatch), async (c) => {
      return c.json(await controller.updateJack(c.req.valid('json')))
    })

    app.patch('/jack/external', configDoc('Update external Jack access', 'Atomically replaces only the external access profile.'), zValidator('json', RawExternalJackConfig), async (c) => {
      return c.json(await controller.updateJackExternal(c.req.valid('json')))
    })

    app.delete('/jack/external', configDoc('Remove external Jack access', 'Atomically removes only the external access profile.'), async (c) => {
      return c.json(await controller.updateJackExternal(null))
    })

    // Reachability from this server only: NAT loopback, split DNS and firewalls
    // make it say nothing certain about friends outside the network.
    app.post('/jack/external/test', describeRoute({
      tags: ['Config'],
      summary: 'Check the address friends use',
      description: 'Fetches `<url>/ping` with the external headers, the way a friend\'s jack reaches this one (a path in the address is replaced by `/ping`, as peers do with `/handshake`), with a 10 second timeout. Without a body it checks the saved `jack.external`; a body `{ url, headers }` (the shape of `PATCH /config/jack/external`) checks those values before they are saved. Answers `{ ok, status, error, url }`: `ok` is true when jack answered its `/ping` there, `status` is the HTTP status (null when nothing answered), `error` says what went wrong in plain words (null when `ok`), and `url` is what was fetched. A pass shows that this server reaches jack at the address; a friend outside your network may still be blocked, and the friend\'s own connection (`lastUsedAt` on the key) is the real test.',
      security: [{ 'X-Management-Key': [] }],
      responses: {
        200: { description: 'The check result (also when the address failed it)', content: { 'application/json': { schema: resolver(ExternalCheckResultSchema) } } },
        400: { description: 'No address saved and none in the body, the body fails validation, or a header reference can\'t be resolved' },
      },
    }), async (c) => {
      const body = await c.req.json().catch(() => null)
      return c.json(await controller.testExternal(body))
    })

    // Partial patch: the body is merged onto the stored downloads block.
    // `unlinkImportedFiles` and `maxConcurrentDownloads` apply immediately; the
    // other knobs are captured at boot and land on next restart.
    app.patch('/downloads', configDoc('Update the downloads block', 'Merges the given fields into the stored downloads config. A body that sets `completedPath` is refused with a 400 (`error.field` is `completedPath`) unless that folder exists and jack can write to it. `unlinkImportedFiles` and `maxConcurrentDownloads` apply immediately; the other values take effect on next boot (see `system.restartPending` on the overview). Creating the block registers jack in every auto-register Radarr/Sonarr in the background, download client included.'), zValidator('json', RawDownloadsConfig), async (c) => {
      return c.json(await controller.updateDownloads(c.req.valid('json')))
    })

    app.patch('/bandwidth', configDoc('Update the bandwidth block', 'Merges the given fields into the stored bandwidth config. `null` removes a limit; `schedule` is replaced as a whole. Applies immediately.'), zValidator('json', RawBandwidthConfig), async (c) => {
      return c.json(await controller.updateBandwidth(c.req.valid('json')))
    })

    app.patch('/torznab', configDoc('Update the torznab block', 'Merges the given fields into the stored torznab config. `null` restores a default. Applies immediately.'), zValidator('json', RawTorznabConfig), async (c) => {
      return c.json(await controller.updateTorznab(c.req.valid('json')))
    })

    app.patch('/notifications', configDoc('Update the notifications block', 'Merges the given fields into the stored notifications config. `null` restores a default; `webhooks` is replaced as a whole. Applies immediately.'), zValidator('json', RawNotificationsConfig), async (c) => {
      return c.json(await controller.updateNotifications(c.req.valid('json')))
    })

    app.patch('/discovery', configDoc('Update the discovery block', 'Merges the given fields into the stored discovery config. `null` restores a default. Applies immediately.'), zValidator('json', RawDiscoveryConfig), async (c) => {
      return c.json(await controller.updateDiscovery(c.req.valid('json')))
    })

    app.patch('/security', configDoc('Update the security block', 'Merges the given fields into the stored security config. `null` restores a default; lists are replaced whole. Applies immediately.'), zValidator('json', RawSecurityConfig), async (c) => {
      return c.json(await controller.updateSecurity(c.req.valid('json')))
    })
  }

  if (controller.canRegister) {
    app.post('/servers/:id/register', describeRoute({
      tags: ['Config'],
      summary: 'Register jack in a server again',
      description: 'Registers jack\'s indexer and download client in this Radarr/Sonarr with a new key, then asks the *arr to test both, and answers with the result. A server that is down gets one connection attempt first. The registration waits behind any registration already running, and a test the *arr can\'t finish takes up to 45 seconds. After 25 seconds the route answers with `registration: null` and `registrationPending: true`, and the result arrives on `/config/stream` and `/overview/stream`.',
      security: [{ 'X-Management-Key': [] }],
      responses: {
        200: { description: 'The registration and test results', content: { 'application/json': { schema: resolver(RegisterResponseSchema) } } },
        400: { description: 'The server isn\'t a destination, or auto-register is off for it (also when that changed while the registration waited)' },
        404: { description: 'No server with this id' },
        502: { description: 'jack can\'t connect to the server' },
      },
    }), zValidator('param', idParam), async (c) => {
      return c.json(await controller.registerServer(c.req.valid('param').id))
    })
  }

  return app
}
