import { describe, expect, test } from 'bun:test'
import { settingsLink, settingsRedirect } from './settings-links'

describe('settingsLink', () => {
  test('links a section on its tab', () => {
    expect(settingsLink('servers')).toBe('/settings#servers')
    expect(settingsLink('public-address')).toBe('/settings/sharing#public-address')
    expect(settingsLink('bandwidth')).toBe('/settings/bandwidth#bandwidth')
    expect(settingsLink('about')).toBe('/settings/advanced#about')
  })

  test('sends sections that moved to Friends there', () => {
    expect(settingsLink('peers')).toBe('/friends')
    expect(settingsLink('access-keys')).toBe('/friends')
  })
})

describe('settingsRedirect', () => {
  test('moves an old single-page link to its tab', () => {
    expect(settingsRedirect('/settings', '#bandwidth')).toBe('/settings/bandwidth#bandwidth')
    expect(settingsRedirect('/settings', '#security')).toBe('/settings/sharing#security')
    expect(settingsRedirect('/settings/', '#rss')).toBe('/settings/advanced#rss')
  })

  test('sends friend sections to Friends', () => {
    expect(settingsRedirect('/settings', '#peers')).toBe('/friends')
    expect(settingsRedirect('/settings', '#access-keys')).toBe('/friends')
  })

  test('leaves a section that is on the page already', () => {
    expect(settingsRedirect('/settings', '#servers')).toBeNull()
    expect(settingsRedirect('/settings/sharing', '#public-address')).toBeNull()
    expect(settingsRedirect('/settings/bandwidth/', '#bandwidth')).toBeNull()
  })

  test('ignores hashes that name no section', () => {
    expect(settingsRedirect('/settings', '')).toBeNull()
    expect(settingsRedirect('/settings', '#')).toBeNull()
    expect(settingsRedirect('/settings', '#tmdb')).toBeNull()
    expect(settingsRedirect('/settings', '#%E0%A4%A')).toBeNull()
  })
})
