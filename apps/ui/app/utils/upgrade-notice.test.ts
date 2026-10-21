import type { SystemNotice } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { opensExceptions } from './security-form'
import { changedSettingLine, noticesToShow } from './upgrade-notice'

describe('changedSettingLine', () => {
  test('names the new defaults of this update, with a link to each switch', () => {
    expect(changedSettingLine({ setting: 'discovery.introduce', now: false })).toEqual({
      text: 'Introducing your friends to each other is now off.',
      detail: null,
      to: '/settings/sharing#friends-of-friends',
    })
    expect(changedSettingLine({ setting: 'security.banEnabled', now: true })).toEqual({
      text: 'Addresses that keep failing a key are now banned for a while.',
      detail: 'Your LAN is never banned.',
      to: '/settings/sharing#security-bans',
    })
    // Lands on the field that lets a Radarr/Sonarr outside the LAN in, which the
    // Security section opens for this link.
    expect(changedSettingLine({ setting: 'security.lanOnlyArrApis', now: true })).toEqual({
      text: 'The Radarr/Sonarr APIs now only answer your LAN.',
      detail: 'If your Radarr or Sonarr reaches jack over Tailscale or from a VPS, add its address under Settings -> Sharing -> Security -> Reverse proxy and exceptions -> Radarr/Sonarr outside your LAN.',
      to: '/settings/sharing#security-arr-outside-lan',
    })
    expect(opensExceptions(new URL(changedSettingLine({ setting: 'security.lanOnlyArrApis', now: true }).to, 'http://x').hash)).toBe(true)
    expect(changedSettingLine({ setting: 'security.publicOpenApi', now: false })).toEqual({
      text: 'The public API description (/openapi.json) is no longer served.',
      detail: null,
      to: '/settings/sharing#security-apis',
    })
  })

  test('reads the other way round too', () => {
    expect(changedSettingLine({ setting: 'discovery.introduce', now: true }).text).toBe('Introducing your friends to each other is now on.')
    expect(changedSettingLine({ setting: 'security.banEnabled', now: false }).text).toBe('Addresses that keep failing a key are no longer banned.')
    expect(changedSettingLine({ setting: 'security.lanOnlyArrApis', now: false })).toMatchObject({ detail: null, to: '/settings/sharing#security-apis' })
  })

  test('shows a setting from a newer jack as jack names it', () => {
    expect(changedSettingLine({ setting: 'security.somethingNew', now: true })).toEqual({ text: 'security.somethingNew is now on.', detail: null, to: '/settings/sharing#security' })
    expect(changedSettingLine({ setting: 'other.thing', now: false }).to).toBe('/settings')
  })
})

describe('noticesToShow', () => {
  const notice = (id: string, changed: SystemNotice['changed']): SystemNotice => ({ id, kind: 'defaultsChanged', changed })
  const change = { setting: 'security.banEnabled' as const, was: false, now: true }

  test('keeps notices with changes that are not dismissed', () => {
    const a = notice('a', [change])
    const b = notice('b', [change])
    expect(noticesToShow([a, b], new Set(['b']))).toEqual([a])
  })

  test('drops empty and unknown notices, and copes with an older jack', () => {
    const unknown = { id: 'c', kind: 'somethingElse', changed: [change] } as unknown as SystemNotice
    expect(noticesToShow([notice('a', []), unknown])).toEqual([])
    expect(noticesToShow(undefined)).toEqual([])
  })
})
