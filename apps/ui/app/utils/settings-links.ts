/**
 * Where each setting lives. Callers link by id (`settingsLink('downloads')`) so
 * moving a section to another settings page only changes this map.
 */
export const SETTINGS_SECTIONS = {
  'internal-url': '/settings',
  'downloads': '/settings',
  'servers': '/settings',
  'public-address': '/settings',
  'peers': '/settings',
  'access-keys': '/settings',
  'friends-of-friends': '/settings',
  'bandwidth': '/settings',
  'rss': '/settings',
  'notifications': '/settings',
  'security': '/settings',
  'tmdb': '/settings',
  'about': '/settings',
} as const

export type SettingsSectionId = keyof typeof SETTINGS_SECTIONS

export function settingsLink(id: SettingsSectionId): string {
  return `${SETTINGS_SECTIONS[id]}#${id}`
}
