// Settings -> Sharing -> Security: which server validation errors belong on which
// field of the form, and the links into the section.
import { splitAddressList } from './address-list'
import { settingsLink } from './settings-links'

/** The fields that hold a list of addresses, as the PATCH body names them. */
export type SecurityListField = 'trustedProxies' | 'neverBan' | 'arrApiAlsoAllowed'

/** The address lists, in the order the form shows them under Reverse proxy and exceptions. */
export const SECURITY_LIST_FIELDS: readonly SecurityListField[] = ['trustedProxies', 'neverBan', 'arrApiAlsoAllowed']

/**
 * Link targets in the Security section (element ids in SecuritySection.vue).
 * `exceptions` is the Reverse proxy and exceptions group, and `arrOutsideLan` the
 * field in it for a Radarr/Sonarr outside the LAN (`arrApiAlsoAllowed`).
 */
export const SECURITY_ANCHORS = {
  bans: 'security-bans',
  apis: 'security-apis',
  exceptions: 'security-exceptions',
  arrOutsideLan: 'security-arr-outside-lan',
} as const

export type SecurityAnchor = keyof typeof SECURITY_ANCHORS

/** A link to one part of the Security section, e.g. `/settings/sharing#security-arr-outside-lan`. */
export function securityLink(anchor: SecurityAnchor): string {
  return `${settingsLink('security').split('#')[0]}#${SECURITY_ANCHORS[anchor]}`
}

const IN_EXCEPTIONS = new Set<string>([SECURITY_ANCHORS.exceptions, SECURITY_ANCHORS.arrOutsideLan])
const LEADING_HASH = /^#/

/**
 * Whether a route hash points into Reverse proxy and exceptions. The group starts
 * closed, so the section opens it for such a link, or the field would be hidden.
 */
export function opensExceptions(hash: string): boolean {
  try {
    return IN_EXCEPTIONS.has(decodeURIComponent(hash.replace(LEADING_HASH, '')))
  }
  catch {
    return false
  }
}

/**
 * How many address lists hold an entry, for the "N custom" count on Reverse proxy
 * and exceptions. A list hidden because its switch is off doesn't count.
 */
export function customListCount(lists: Readonly<Record<SecurityListField, string>>, fields: ReadonlySet<string>): number {
  return SECURITY_LIST_FIELDS.filter(field => fields.has(field) && splitAddressList(lists[field]).length > 0).length
}

/** Whether one of these form errors is on an address list, which is folded away until opened. */
export function hasListError(errors: readonly { name?: string }[]): boolean {
  return errors.some(error => (SECURITY_LIST_FIELDS as readonly (string | undefined)[]).includes(error.name))
}

// Whether a message mentions the entry as a word of its own, quoted or not.
const NOT_ADDRESS_CHARS = /[^\w.:/-]+/
const names = (message: string, entry: string) => message.split(NOT_ADDRESS_CHARS).includes(entry)

export interface SecurityIssue {
  field: string | null
  message: string
}

/**
 * The form errors for a refused save, on the field each issue names. An issue on
 * one list entry (`neverBan.2`) quotes that entry, so the user sees which one.
 * Issues on fields not in `fields` (hidden ones, or not part of the form) are
 * left out.
 */
export function securityFieldErrors(
  issues: readonly SecurityIssue[],
  sent: Partial<Record<SecurityListField, readonly string[] | null>>,
  fields: ReadonlySet<string>,
): { name: string, message: string }[] {
  const errors: { name: string, message: string }[] = []
  for (const issue of issues) {
    const [name = '', index] = (issue.field ?? '').split('.')
    if (!fields.has(name) || errors.some(e => e.name === name))
      continue
    const entry = index === undefined ? undefined : sent[name as SecurityListField]?.[Number(index)]
    const message = entry && !names(issue.message, entry) ? `"${entry}": ${issue.message}` : issue.message
    errors.push({ name, message })
  }
  return errors
}

/** A stored list entry jack ignores, as GET config/security reports it. */
export interface IgnoredEntry {
  field: SecurityListField
  value: string
}

/** The ignored entries of one field, in order and each once. */
export function ignoredOnField(entries: readonly IgnoredEntry[] | null | undefined, field: SecurityListField): string[] {
  return [...new Set((entries ?? []).filter(entry => entry.field === field).map(entry => String(entry.value)))]
}

const quoteList = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

/**
 * Why jack ignores these entries of a field, naming each, and that saving removes
 * them. Any save of the security settings drops every ignored entry from
 * config.jsonc, whichever field it is in, so no note offers a choice per field.
 */
export function ignoredEntriesNote(values: readonly string[]): string {
  const names = quoteList.format(values.map(value => `"${value}"`))
  return values.length === 1
    ? `jack ignores ${names}, because it isn't an IP address or range. Saving the security settings removes it.`
    : `jack ignores ${names}, because they aren't IP addresses or ranges. Saving the security settings removes them.`
}

/**
 * Whether Save has something to do: a change in the form, or stored entries jack
 * ignores, which the save removes. Without the second, entries the form can't show
 * could never be removed.
 */
export function securityCanSave(changed: boolean, ignored: readonly IgnoredEntry[] | null | undefined): boolean {
  return changed || (ignored?.length ?? 0) > 0
}
