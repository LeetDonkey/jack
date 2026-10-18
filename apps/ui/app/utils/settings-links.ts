/**
 * Where each setting lives. Callers link by id (`settingsLink('downloads')`) so
 * moving a section to another settings page only changes this map.
 */
export const SETTINGS_SECTIONS = {
  'internal-url': '/settings',
  'downloads': '/settings',
  'servers': '/settings',
  'public-address': '/settings/sharing',
  'friends-of-friends': '/settings/sharing',
  'security': '/settings/sharing',
  'bandwidth': '/settings/bandwidth',
  'notifications': '/settings/notifications',
  'rss': '/settings/advanced',
  'other-keys': '/settings/advanced',
  'about': '/settings/advanced',
} as const

// Sections that left Settings. A link to one opens the page that took it over.
const MOVED_SECTIONS = {
  'peers': '/friends',
  'access-keys': '/friends',
} as const

export type SettingsSectionId = keyof typeof SETTINGS_SECTIONS | keyof typeof MOVED_SECTIONS

function isSectionId(id: string): id is SettingsSectionId {
  return Object.hasOwn(SETTINGS_SECTIONS, id) || Object.hasOwn(MOVED_SECTIONS, id)
}

function isMoved(id: SettingsSectionId): id is keyof typeof MOVED_SECTIONS {
  return Object.hasOwn(MOVED_SECTIONS, id)
}

export function settingsLink(id: SettingsSectionId): string {
  if (isMoved(id))
    return MOVED_SECTIONS[id]
  return `${SETTINGS_SECTIONS[id]}#${id}`
}

const LEADING_HASH = /^#/
const TRAILING_SLASHES = /\/+$/

/**
 * Where an older deep link belongs now. Settings used to be one page, so links
 * and bookmarks like `/settings#bandwidth` or `/settings#peers` name a section
 * that has since moved to a tab or to Friends. Null when the section is on
 * `path` already, or the hash names no known section.
 */
export function settingsRedirect(path: string, hash: string): string | null {
  let id: string
  try {
    id = decodeURIComponent(hash.replace(LEADING_HASH, ''))
  }
  catch {
    return null
  }
  if (!isSectionId(id))
    return null
  const target = settingsLink(id)
  const targetPath = target.split('#')[0]
  const currentPath = path.replace(TRAILING_SLASHES, '') || '/'
  return targetPath === currentPath ? null : target
}
