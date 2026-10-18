/** Display name for a server's `type` ("radarr" -> "Radarr"). */
export function arrName(type: string): string {
  return type === 'sonarr' ? 'Sonarr' : 'Radarr'
}

/**
 * What a Radarr/Sonarr does for jack, in words: `source` shares its library with
 * friends, `destination` receives downloads from them.
 */
export function serverRoleLabel(server: { source: boolean, destination: boolean }): string {
  const roles: string[] = []
  if (server.source)
    roles.push('shares with friends')
  if (server.destination)
    roles.push('receives downloads')
  return roles.join(' · ') || 'not in use'
}
