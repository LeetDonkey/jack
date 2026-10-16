import type { Server } from 'node:http'
import { serve } from '@hono/node-server'

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
  return serve({ fetch, port, overrideGlobalObjects: false }) as Server
}
