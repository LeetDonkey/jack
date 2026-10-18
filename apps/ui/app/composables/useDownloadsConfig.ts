import type { DownloadsConfig } from '~/types/management'

/**
 * The downloads block of the config file. `null` is a real answer: the block is
 * absent, so downloads are off. Shared by key, so the Radarr/Sonarr dialog sees what
 * Settings → Downloads just saved. A caller that mounts while the value is already
 * loaded reuses it instead of fetching again: a fresh object would re-seed the
 * Downloads form and throw away unsaved edits there.
 */
export function useDownloadsConfig() {
  const { request } = useManagement()
  const { data: cached } = useNuxtData<DownloadsConfig | null>('downloads-config')
  return useLazyAsyncData(
    'downloads-config',
    () => request<DownloadsConfig | null>('config/downloads'),
    { immediate: cached.value === undefined },
  )
}
