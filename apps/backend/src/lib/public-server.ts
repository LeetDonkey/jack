import type { IncomingMessage, RequestListener, Server, ServerOptions } from 'node:http'
import { createServer } from 'node:http'
import { serve } from '@hono/node-server'

/**
 * Whether the client asked to close the connection after this request
 * (`Connection: close`, a comma-separated list of tokens).
 */
export function asksToClose(request: Pick<IncomingMessage, 'headers'>): boolean {
  const connection = request.headers.connection
  return typeof connection === 'string' && connection.split(',').some(token => token.trim().toLowerCase() === 'close')
}

/**
 * A node:http server that says `Connection: close` when the request asked for
 * it. Bun's node:http closes such a connection after the response without saying
 * so, and Radarr/Sonarr (.NET), which send `Connection: close` on qBittorrent
 * calls, then reuse it: the login they send right after a 403 (no session yet,
 * as after every jack restart) goes out on the closing socket and fails with
 * "The response ended prematurely" ("Unable to connect to qBittorrent").
 */
export function createClosingServer(options: ServerOptions, listener: RequestListener): Server {
  return createServer(options, (request, response) => {
    if (asksToClose(request))
      response.setHeader('Connection', 'close')
    listener(request, response)
  })
}

/**
 * Start the public (peer/*arr-facing) server on node:http.
 *
 * Bun.serve drains a streamed response body without backpressure, so pacing or
 * metering an upload there means buffering the whole file in memory; node:http
 * writes wait for the socket.
 *
 * `overrideGlobalObjects: false` matters: by default @hono/node-server replaces
 * the global Request/Response with its own lightweight classes. The management
 * API still runs on Bun.serve in the same process, and Bun.serve answers 204 to
 * every request whose handler returns one of those foreign Response objects.
 */
export function startPublicServer(fetch: (request: Request) => Response | Promise<Response>, port: number): Server {
  return serve({ fetch, port, overrideGlobalObjects: false, createServer: createClosingServer as typeof createServer }) as Server
}
