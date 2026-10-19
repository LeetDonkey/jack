// Settings -> Sharing -> Security: which server validation errors belong on which
// field of the form.

/** The fields that hold a list of addresses, as the PATCH body names them. */
export type SecurityListField = 'trustedProxies' | 'neverBan' | 'arrApiAlsoAllowed'

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
