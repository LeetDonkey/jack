import { isIP } from 'node:net'

/** Private, loopback and link-local ranges: where a reverse proxy or the LAN lives. */
export const PRIVATE_RANGES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]

const BRACKETS = /^\[|\]$/g
const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i
const V4_TAIL = /(\d+\.\d+\.\d+\.\d+)$/

/** Strip an IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` -> `1.2.3.4`) and surrounding brackets. */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().replace(BRACKETS, '')
  const mapped = MAPPED_V4.exec(ip)
  return mapped ? mapped[1]! : ip.toLowerCase()
}

const PREFIX = /^\d{1,3}$/

/**
 * Whether `entry` is an IPv4 or IPv6 address, or a CIDR range with a prefix
 * that fits its family (`172.18.0.0/16`, `fd00::/8`). Host and container names
 * are not: inRanges never matches them.
 */
export function isAddressOrRange(entry: string): boolean {
  const [base = '', prefix, extra] = entry.trim().split('/')
  const ip = normalizeIp(base)
  // A zone id (fe80::1%eth0) never matches a client address.
  const family = ip.includes('%') ? 0 : isIP(ip)
  if (family === 0 || extra !== undefined)
    return false
  return prefix === undefined || (PREFIX.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128))
}

function ipv4ToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n)
}

function ipv6ToBigInt(ip: string): bigint {
  // Expand an embedded IPv4 tail (e.g. ::ffff:1.2.3.4 that wasn't normalized) into two groups.
  let text = ip
  const v4 = V4_TAIL.exec(text)
  if (v4) {
    const n = ipv4ToBigInt(v4[1]!)
    text = `${text.slice(0, -v4[1]!.length)}${(n >> 16n).toString(16)}:${(n & 0xFFFFn).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const missing = 8 - headGroups.length - tailGroups.length
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array.from<string>({ length: missing }).fill('0'), ...tailGroups]
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(Number.parseInt(g || '0', 16)), 0n)
}

/** Whether `ip` falls inside any of the CIDR ranges (a bare address counts as a /32 or /128). */
export function inRanges(rawIp: string, ranges: readonly string[]): boolean {
  const ip = normalizeIp(rawIp)
  const family = isIP(ip)
  if (family === 0)
    return false
  const value = family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip)
  const bits = family === 4 ? 32 : 128
  return ranges.some((range) => {
    const [base = '', prefixText] = range.split('/')
    const baseIp = normalizeIp(base)
    if (isIP(baseIp) !== family)
      return false
    const prefix = prefixText === undefined ? bits : Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits)
      return false
    const baseValue = family === 4 ? ipv4ToBigInt(baseIp) : ipv6ToBigInt(baseIp)
    const shift = BigInt(bits - prefix)
    return (value >> shift) === (baseValue >> shift)
  })
}

/** Headers a reverse proxy adds to name the client. A client connecting directly never sends them. */
export const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'] as const

/** X-Real-IP, normalized, when it holds an address. */
export function realIpHeader(headers: { get: (name: string) => string | null }): string | null {
  const realIp = headers.get('x-real-ip')
  return realIp && isIP(normalizeIp(realIp)) ? normalizeIp(realIp) : null
}

/**
 * The client's address. Forwarding headers are believed only when the direct
 * peer is a trusted proxy (otherwise anyone could claim any address): then the
 * rightmost `X-Forwarded-For` entry that isn't itself a trusted proxy, else
 * `X-Real-IP`. X-Forwarded-For comes first because every common proxy appends
 * the address it sees there (nginx, Traefik, HAProxy, Go's ReverseProxy) or
 * replaces it (Caddy), so the client can't forge the rightmost entry; some of
 * them pass a client's own X-Real-IP through untouched.
 */
export function clientIp(remoteAddress: string | undefined, headers: { get: (name: string) => string | null }, trustedProxies: readonly string[]): string | null {
  const direct = remoteAddress ? normalizeIp(remoteAddress) : null
  if (!direct || !inRanges(direct, trustedProxies))
    return direct
  const forwarded = (headers.get('x-forwarded-for') ?? '').split(',').map(s => normalizeIp(s)).filter(s => isIP(s))
  for (let i = forwarded.length - 1; i >= 0; i--) {
    if (!inRanges(forwarded[i]!, trustedProxies))
      return forwarded[i]!
  }
  // Every entry is a trusted (LAN) address: the leftmost is the client.
  if (forwarded.length > 0)
    return forwarded[0]!
  return realIpHeader(headers) ?? direct
}
