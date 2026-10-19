import type { SystemNotice } from '~/types/management'
import { settingsLink } from './settings-links'

// The notice an update leaves for installs that existed before it
// (overview.system.notices), in words, with a link to each switch.

export interface ChangedSettingLine {
  /** What changed, as a sentence. */
  text: string
  /** What it means for the user, or null. */
  detail: string | null
  /** The switch in Settings. */
  to: string
}

// The Security section's cards carry these ids (SecuritySection.vue).
const SHARING_PATH = settingsLink('security').split('#')[0]
const BANS = `${SHARING_PATH}#security-bans`
const APIS = `${SHARING_PATH}#security-apis`

/** One changed setting in words. A setting this UI doesn't know yet (a newer jack) shows as jack names it. */
export function changedSettingLine(change: { setting: string, now: boolean }): ChangedSettingLine {
  const { setting, now } = change
  switch (setting) {
    case 'discovery.introduce':
      return {
        text: now ? 'Introducing your friends to each other is now on.' : 'Introducing your friends to each other is now off.',
        detail: null,
        to: settingsLink('friends-of-friends'),
      }
    case 'security.banEnabled':
      return {
        text: now ? 'Addresses that keep failing a key are now banned for a while.' : 'Addresses that keep failing a key are no longer banned.',
        detail: now ? 'Your LAN is never banned.' : null,
        to: BANS,
      }
    case 'security.lanOnlyArrApis':
      return {
        text: now ? 'The Radarr/Sonarr APIs now only answer your LAN.' : 'The Radarr/Sonarr APIs now answer every address.',
        detail: now ? 'If your Radarr or Sonarr reaches jack over Tailscale or from a VPS, add its address under Also allow.' : null,
        to: APIS,
      }
    case 'security.publicOpenApi':
      return {
        text: now ? 'The public API description (/openapi.json) is now served.' : 'The public API description (/openapi.json) is no longer served.',
        detail: null,
        to: APIS,
      }
    default:
      return {
        text: `${setting} is now ${now ? 'on' : 'off'}.`,
        detail: null,
        to: setting.startsWith('discovery.') ? settingsLink('friends-of-friends') : setting.startsWith('security.') ? settingsLink('security') : '/settings',
      }
  }
}

/** The notices to show: kinds this UI knows, with something in them, and not dismissed here already. */
export function noticesToShow(notices: readonly SystemNotice[] | undefined, dismissed: ReadonlySet<string> = new Set()): SystemNotice[] {
  return (notices ?? []).filter(n => n.kind === 'defaultsChanged' && n.changed?.length > 0 && !dismissed.has(n.id))
}
