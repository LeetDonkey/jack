import type { JackConfig } from '~/types/management'

/**
 * config.jack: the address Radarr/Sonarr use and your public address. Settings
 * sections that edit or show it share this one copy, so a save in one is seen by
 * the others on the same tab.
 */
export function useJackConfig() {
  const { request } = useManagement()
  return useLazyAsyncData('jack-config', () => request<JackConfig | null>('config/jack'))
}
