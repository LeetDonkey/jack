// Lists of IP addresses and CIDR ranges typed into one field (Settings -> Sharing
// -> Security). jack only matches real addresses, so anything else in such a list
// (a host or container name) silently matches nothing.

const SEPARATORS = /[\s,]+/
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_CHARS = /^[\da-f:.]+$/i
const PREFIX = /^\d{1,3}$/

/** The entries of a list typed with commas, spaces or line breaks between them. */
export function splitAddressList(text: string): string[] {
  return text.split(SEPARATORS).map(s => s.trim()).filter(Boolean)
}

function ipFamily(ip: string): 4 | 6 | null {
  if (IPV4.test(ip))
    return 4
  if (!ip.includes(':') || !IPV6_CHARS.test(ip))
    return null
  // The URL parser knows every valid IPv6 spelling (::, an IPv4 tail) and nothing else.
  try {
    void new URL(`http://[${ip}]/`)
    return 6
  }
  catch {
    return null
  }
}

/** Whether `entry` is an IPv4 or IPv6 address, or a range such as 172.18.0.0/16. */
export function isAddressOrRange(entry: string): boolean {
  const [ip = '', prefix, extra] = entry.split('/')
  const family = ipFamily(ip)
  if (!family || extra !== undefined)
    return false
  if (prefix === undefined)
    return true
  return PREFIX.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
}

/** The entries of `text` that aren't an address or range, in order and each once. */
export function invalidAddresses(text: string): string[] {
  return [...new Set(splitAddressList(text).filter(entry => !isAddressOrRange(entry)))]
}

const SHOWN = 3

/** The field error for a list with entries that aren't addresses, naming them; null when every entry is fine. */
export function addressListError(text: string): string | null {
  const bad = invalidAddresses(text)
  if (bad.length === 0)
    return null
  const quoted = bad.slice(0, SHOWN).map(entry => `"${entry}"`)
  const more = bad.length - quoted.length
  const names = more > 0
    ? `${quoted.join(', ')} and ${more} more`
    : quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
  const verb = bad.length === 1 ? 'isn\'t an IP address or range' : 'aren\'t IP addresses or ranges'
  return `${names} ${verb}. Enter addresses like 192.168.1.10 or ranges like 172.18.0.0/16, separated by commas.`
}
