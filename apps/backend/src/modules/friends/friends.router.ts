import type { BandwidthConfig } from '../../lib/config'
import type { ApiKeysRepository } from '../api-keys/api-keys.repository'
import type { TrafficLedger } from '../transfers/traffic-ledger'
import type { TransferMonitor } from '../transfers/transfer-monitor'
import type { PeerHealth, PeerHealthMonitor } from './peer-health'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { localDay } from '../transfers/traffic-ledger'

export interface TrafficWindow {
  today: number
  week: number
  month: number
}

export interface FriendsSnapshot {
  /** Friends you download from (the peers in your config). */
  peers: Array<PeerHealth & { downloaded: TrafficWindow }>
  /** Friends who download from you (the API keys you issued). */
  keys: Array<{ id: number, name: string | null, expiresAt: string | null, activeUploads: number, uploaded: TrafficWindow }>
  limits: { maxConcurrentUploadsPerPeer: number | null, dailyUploadLimitGiBPerPeer: number | null }
}

export interface FriendsDeps {
  health: Pick<PeerHealthMonitor, 'list'>
  ledger?: Pick<TrafficLedger, 'totalsSince'>
  monitor?: Pick<TransferMonitor, 'activeCount'>
  apiKeys?: Pick<ApiKeysRepository, 'list'>
  bandwidth: () => BandwidthConfig | undefined
  now?: () => Date
}

export function friendsSnapshot(deps: FriendsDeps): FriendsSnapshot {
  const now = (deps.now ?? (() => new Date()))()
  const daysAgo = (days: number) => localDay(new Date(now.getTime() - days * 86_400_000))
  const windows = { today: daysAgo(0), week: daysAgo(6), month: daysAgo(29) }
  const totals = Object.fromEntries(Object.entries(windows).map(([name, from]) => [name, deps.ledger?.totalsSince(from) ?? []])) as Record<keyof TrafficWindow, ReturnType<TrafficLedger['totalsSince']>>
  const traffic = (direction: 'in' | 'out', party: string): TrafficWindow => ({
    today: totals.today.find(t => t.direction === direction && t.party === party)?.bytes ?? 0,
    week: totals.week.find(t => t.direction === direction && t.party === party)?.bytes ?? 0,
    month: totals.month.find(t => t.direction === direction && t.party === party)?.bytes ?? 0,
  })
  const bandwidth = deps.bandwidth()
  return {
    peers: deps.health.list().map(peer => ({ ...peer, downloaded: traffic('in', `peer:${peer.id}`) })),
    keys: (deps.apiKeys?.list() ?? []).map(key => ({
      id: key.id,
      name: key.name,
      expiresAt: key.expiresAt,
      activeUploads: deps.monitor?.activeCount('upload', `key:${key.id}`) ?? 0,
      uploaded: traffic('out', `key:${key.id}`),
    })),
    limits: {
      maxConcurrentUploadsPerPeer: bandwidth?.maxConcurrentUploadsPerPeer ?? null,
      dailyUploadLimitGiBPerPeer: bandwidth?.dailyUploadLimitGiBPerPeer ?? null,
    },
  }
}

export function getFriendsRouter(deps: FriendsDeps) {
  const app = new Hono()
  app.get('/', describeRoute({
    tags: ['Friends'],
    summary: 'Friends overview',
    description: 'Every peer you download from, with reachability, version and bytes downloaded, and every API key you issued, with bytes uploaded to it. Traffic windows are today, the last 7 days and the last 30 days (server time).',
    responses: { 200: { description: 'Friends snapshot' } },
  }), c => c.json(friendsSnapshot(deps)))
  return app
}
