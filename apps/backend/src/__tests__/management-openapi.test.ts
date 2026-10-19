import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { ConnectorManager } from '../lib/servers'
import { getManagementApp } from '../management-app'
import { ApiKeysRepository } from '../modules/api-keys/api-keys.repository'
import { ConfigService } from '../modules/config/config.service'
import { PeerHealthMonitor } from '../modules/friends/peer-health'

describe('management OpenAPI spec', () => {
  test('documents the friend routes, peer save errors and the overview health', async () => {
    const db = drizzle({ client: new Database(':memory:'), schema })
    runMigrations(db)
    const connectors = new ConnectorManager([], [])
    const configService = new ConfigService({ path: '/tmp/jack-openapi-test.jsonc', raw: { version: 2, servers: [], peers: [] } as any, connectorManager: connectors })
    const app = getManagementApp({
      environment: 'test',
      managementKey: 'k',
      connectors,
      configService,
      apiKeysRepository: new ApiKeysRepository(db),
      peerHealth: new PeerHealthMonitor(() => [], () => 60_000),
    })

    const spec = await (await app.request('/openapi.json')).json() as any
    expect(Object.keys(spec.paths['/config/peers'].post.responses)).toEqual(['201', '400', '409', '502'])
    expect(spec.paths['/config/peers/{id}'].patch.responses['502'].description).toContain('error.reason')
    expect(spec.paths['/friends/check'].post.summary).toBe('Check every friend now')
    expect(spec.paths['/api-keys/{id}'].patch.requestBody.content['application/json'].schema.properties.peerId).toBeDefined()
    expect(Object.keys(spec.paths['/quick-links'].post.requestBody.content['application/json'].schema.properties)).toContain('replaceKeyId')

    const json = (operation: any, status: string) => operation.responses[status].content['application/json'].schema
    const friends = json(spec.paths['/friends'].get, '200')
    expect(Object.keys(friends.properties)).toEqual(['peers', 'keys', 'limits', 'friends', 'unlinked'])
    expect(friends.properties.friends.items.properties.state.enum).toEqual(['offline', 'noKey', 'noPeer', 'stale', 'waiting', 'both'])
    expect(friends.properties.keys.items.properties.lastUsedTrackedSince).toBeDefined()
    expect(friends.properties.peers.items.properties.identityId).toBeDefined()
    expect(json(spec.paths['/friends/check'].post, '200').properties.friends).toBeDefined()

    const quickLink = json(spec.paths['/quick-links'].post, '201')
    expect(Object.keys(quickLink.properties)).toEqual(['link', 'key', 'replaced'])
    expect(JSON.stringify(quickLink.properties.replaced)).toContain('unknown')
    expect(Object.keys(spec.paths['/api-keys/{id}'].patch.responses)).toEqual(['200', '400', '404'])
    expect(json(spec.paths['/api-keys'].get, '200').items.properties.lastUsedAt).toBeDefined()
    expect(json(spec.paths['/api-keys'].post, '201').properties.key).toBeDefined()

    const peers = spec.paths['/overview'].get.responses['200'].content['application/json'].schema.properties.peers
    expect(Object.keys(peers.properties)).toEqual(['total', 'initialized', 'online', 'items'])
    expect(Object.keys(peers.properties.items.items.properties.health.properties)).toEqual(['online', 'offlineSince', 'lastSeenAt', 'lastError', 'lastErrorCode', 'checkedAt'])

    const system = spec.paths['/overview'].get.responses['200'].content['application/json'].schema.properties.system
    expect(Object.keys(system.properties)).toEqual(['bootedAt', 'restartPending', 'notices'])
    expect(system.properties.notices.items.properties.changed.items.properties.setting.enum).toEqual(['discovery.introduce', 'security.banEnabled', 'security.lanOnlyArrApis', 'security.publicOpenApi'])
    const dismiss = spec.paths['/system/notices/{id}/dismiss'].post
    expect(Object.keys(dismiss.responses)).toEqual(['204', '404'])
    expect(dismiss.operationId).toBe('postSystemNoticesByIdDismiss')
  })
})
