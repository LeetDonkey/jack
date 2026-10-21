import type { SupportBundleDeps } from './support-bundle'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { buildSupportBundle, SUPPORT_LOG_LINES } from './support-bundle'

export function getSupportRouter(deps: SupportBundleDeps) {
  const app = new Hono()
  app.get('/', describeRoute({
    tags: ['System'],
    summary: 'Support bundle',
    description: [
      `A redacted summary to share when asking a friend for help: \`jack\` (\`{ version, revision, buildDate }\`), \`timeZone\` and \`utcOffset\`, \`internalUrlHost\` (host and port only), \`externalConfigured\`, \`downloads\` (\`{ configured, active }\`), \`restartPending\`, \`paused\`, \`servers\` (name, type, roles, whether jack registers itself, \`initialized\` and its error, the last \`registration\` and \`lastContactAt\`), \`peers\` (name, \`connected\`, health, version and \`build\`), \`keys\` (name, created, expiry, \`lastUsedAt\`, \`origin\`, \`linkedToPeer\`) and \`logs\`: the last ${SUPPORT_LOG_LINES} warnings, errors and lines saying that a Radarr, Sonarr or friend that failed to connect is reachable again.`,
      'Server and friend addresses are not fields of the bundle, but URLs inside error messages and log lines (a failed request to an *arr or a friend, for example) keep their host and path. Every string is scrubbed: the API keys, header values and webhook URLs in the config, URL credentials, webhook URLs, credential query parameters (`apikey=`, `token=`, ...), header values written as text, and anything shaped like a key are replaced with `[redacted]` or `[webhook URL removed]`.',
    ].join(' '),
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'The support bundle', content: { 'application/json': {} } } },
  }), async c => c.json(await buildSupportBundle(deps)))
  return app
}
