import type { NotificationsConfig } from '../../lib/config'
import { logger } from '../../logger'
import { localDay } from '../transfers/traffic-ledger'

export type NotificationEvent = 'download-failed' | 'peer-offline' | 'peer-back' | 'daily-summary' | 'test'

export interface Notification {
  event: NotificationEvent
  title: string
  message: string
}

type Webhook = NotificationsConfig['webhooks'][number]

const SEND_TIMEOUT_MS = 10_000
const SUMMARY_CHECK_MS = 30_000
// HTTP headers are Latin-1; ntfy's Title header can't carry anything else.
function latin1(text: string): string {
  return [...text].filter((c) => {
    const code = c.codePointAt(0)!
    return code >= 0x20 && code <= 0xFF
  }).join('')
}
// HH:MM in the server's time zone.
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

function request(webhook: Webhook, notification: Notification, at: Date): { body: string, headers: Record<string, string> } {
  switch (webhook.type) {
    case 'discord':
      return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${notification.title}**\n${notification.message}` }) }
    case 'ntfy':
      return { headers: { 'Title': latin1(notification.title), 'Content-Type': 'text/plain; charset=utf-8' }, body: notification.message }
    case 'json':
      return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...notification, at: at.toISOString() }) }
  }
}

/**
 * Sends jack's notifications to the configured webhooks. The config is read on
 * every send, so edits in the management UI apply at once. A webhook that fails
 * is logged; it never affects what triggered the notification.
 */
export class NotificationsService {
  private timer: ReturnType<typeof setInterval> | undefined
  private summarySentFor: string | undefined

  constructor(
    private readonly getConfig: () => NotificationsConfig | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Whether notifications of this kind would go anywhere right now. */
  wants(event: NotificationEvent): boolean {
    const config = this.getConfig()
    if (!config?.webhooks.length)
      return false
    if (event === 'download-failed')
      return config.downloadFailed
    if (event === 'peer-offline' || event === 'peer-back')
      return config.peerOffline
    if (event === 'daily-summary')
      return config.dailySummaryAt != null
    return true
  }

  /** Send to every webhook; resolves with the number that accepted it. */
  async send(notification: Notification): Promise<number> {
    if (!this.wants(notification.event))
      return 0
    const at = this.now()
    const results = await Promise.all(this.getConfig()!.webhooks.map(async (webhook) => {
      try {
        const { body, headers } = request(webhook, notification, at)
        const response = await this.fetchImpl(webhook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
        if (!response.ok)
          throw new Error(`HTTP ${response.status}`)
        return true
      }
      catch (err) {
        logger.warn({ type: webhook.type, event: notification.event, error: err instanceof Error ? err.message : String(err) }, 'Notification webhook failed')
        return false
      }
    }))
    return results.filter(Boolean).length
  }

  /** Send the daily summary once a day at `dailySummaryAt`, built by `build`. */
  startDailySummary(build: () => Notification): void {
    if (this.timer)
      return
    // Started after today's time (a restart): today's summary is not owed any more.
    const at = this.getConfig()?.dailySummaryAt
    if (at && timeFormat.format(this.now()) >= at)
      this.summarySentFor = localDay(this.now())
    this.timer = setInterval(() => void this.maybeSendSummary(build), SUMMARY_CHECK_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
  }

  /** One check of the summary clock. Driven by the interval; exposed for tests. */
  async maybeSendSummary(build: () => Notification): Promise<boolean> {
    const at = this.getConfig()?.dailySummaryAt
    if (!at)
      return false
    const now = this.now()
    const today = localDay(now)
    if (this.summarySentFor === today || timeFormat.format(now) < at)
      return false
    this.summarySentFor = today
    await this.send(build())
    return true
  }
}
