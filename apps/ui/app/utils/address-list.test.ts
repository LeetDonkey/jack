import { describe, expect, test } from 'bun:test'
import { addressListError, invalidAddresses, isAddressOrRange, splitAddressList } from './address-list'

describe('splitAddressList', () => {
  test('splits on commas, spaces and line breaks', () => {
    expect(splitAddressList(' 10.0.0.1, 172.18.0.0/16\n::1  fe80::/10,')).toEqual(['10.0.0.1', '172.18.0.0/16', '::1', 'fe80::/10'])
    expect(splitAddressList('  ')).toEqual([])
  })
})

describe('isAddressOrRange', () => {
  test('accepts IPv4 addresses and ranges', () => {
    for (const entry of ['192.168.1.10', '0.0.0.0', '255.255.255.255', '172.18.0.0/16', '100.64.0.0/10', '10.0.0.0/0', '1.2.3.4/32'])
      expect(isAddressOrRange(entry)).toBe(true)
  })

  test('accepts IPv6 addresses and ranges', () => {
    for (const entry of ['::1', '::', 'fe80::1', 'fd00::/8', '2001:db8::/32', '::ffff:192.168.1.10', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::1/128'])
      expect(isAddressOrRange(entry)).toBe(true)
  })

  test('refuses names and broken addresses', () => {
    for (const entry of ['Nginx', 'npm', 'localhost', 'proxy.example.com', '192.168.1', '192.168.1.256', '01.2.3.4', '1.2.3.4.5', '0x7f.0.0.1', ':::1', '2001:db8::1::2', 'fe80::1%eth0', '[::1]', '1.2.3.4:80'])
      expect(isAddressOrRange(entry)).toBe(false)
  })

  test('refuses a prefix that is too long or not a number', () => {
    for (const entry of ['10.0.0.0/33', '::/129', '10.0.0.0/', '10.0.0.0/x', '10.0.0.0/8/8', '10.0.0.0/-1', '/16'])
      expect(isAddressOrRange(entry)).toBe(false)
  })
})

describe('invalidAddresses', () => {
  test('lists every bad entry once, in order', () => {
    expect(invalidAddresses('Nginx Proxy Manager, 172.18.0.0/16, Nginx')).toEqual(['Nginx', 'Proxy', 'Manager'])
    expect(invalidAddresses('10.0.0.1, ::1')).toEqual([])
  })
})

describe('addressListError', () => {
  test('is null for an empty or valid list', () => {
    expect(addressListError('')).toBeNull()
    expect(addressListError('172.18.0.0/16, 192.168.1.10')).toBeNull()
  })

  test('names one bad entry', () => {
    expect(addressListError('npm')).toBe('"npm" isn\'t an IP address or range. Enter addresses like 192.168.1.10 or ranges like 172.18.0.0/16, separated by commas.')
  })

  test('names several bad entries', () => {
    expect(addressListError('Nginx Proxy Manager')).toStartWith('"Nginx", "Proxy" and "Manager" aren\'t IP addresses or ranges.')
    expect(addressListError('a b c d e')).toStartWith('"a", "b", "c" and 2 more aren\'t IP addresses or ranges.')
  })
})
