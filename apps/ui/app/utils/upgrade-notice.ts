import type { SystemNotice } from '~/types/management'
import { securityLink } from './security-form'
import { settingsLink } from './settings-links'

// The notice an update leaves for installs that existed before it
// (overview.system.notices), in words, with a link to each switch.

export interface ChangedSettingLine {
  /** What changed, as a sentence. */
  text: string
  /** What it means for the user, or null. */
  detail: string | null
  /** Where to change it in Settings: the switch, or the field `detail` names. */
  to: string
}

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
        to: securityLink('bans'),
      }
    case 'security.lanOnlyArrApis':
      return {
        text: now ? 'The Radarr/Sonarr APIs now only answer your LAN.' : 'The Radarr/Sonarr APIs now answer every address.',
        detail: now ? 'If your Radarr or Sonarr reaches jack over Tailscale or from a VPS, add its address under Settings -> Sharing -> Security -> Reverse proxy and exceptions -> Radarr/Sonarr outside your LAN.' : null,
        // The link opens the folded group at that field. The switch is in the card above it.
        to: now ? securityLink('arrOutsideLan') : securityLink('apis'),
      }
    case 'security.publicOpenApi':
      return {
        text: now ? 'The public API description (/openapi.json) is now served.' : 'The public API description (/openapi.json) is no longer served.',
        detail: null,
        to: securityLink('apis'),
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
