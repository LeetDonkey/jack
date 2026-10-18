import { describe, expect, test } from 'bun:test'
import { arrName, serverRoleLabel } from './server-role'

describe('serverRoleLabel', () => {
  test('names each role in words', () => {
    expect(serverRoleLabel({ source: true, destination: false })).toBe('shares with friends')
    expect(serverRoleLabel({ source: false, destination: true })).toBe('receives downloads')
    expect(serverRoleLabel({ source: true, destination: true })).toBe('shares with friends · receives downloads')
  })

  test('says when a server does nothing', () => {
    expect(serverRoleLabel({ source: false, destination: false })).toBe('not in use')
  })
})

describe('arrName', () => {
  test('capitalizes the server type', () => {
    expect(arrName('radarr')).toBe('Radarr')
    expect(arrName('sonarr')).toBe('Sonarr')
  })
})
