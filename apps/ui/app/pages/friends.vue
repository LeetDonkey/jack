<script setup lang="ts">
import type { FriendPeer, FriendsSnapshot, TrafficWindow } from '~/types/management'

const { request } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('friends', () => request<FriendsSnapshot>('friends'))

// Reachability is probed every 5 minutes and traffic is flushed every 30 seconds,
// so a slow poll is enough.
const timer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
  timer.value = setInterval(() => void refresh(), 30_000)
})
onBeforeUnmount(() => clearInterval(timer.value))

function status(peer: FriendPeer): { color: 'success' | 'error' | 'neutral', label: string } {
  if (peer.online === true)
    return { color: 'success', label: 'Online' }
  if (peer.online === false)
    return { color: 'error', label: peer.offlineSince ? `Offline since ${formatAgo(peer.offlineSince)}` : 'Offline' }
  return { color: 'neutral', label: 'Not checked yet' }
}

function trafficLine(window: TrafficWindow): string {
  return `${formatBytes(window.today)} today · ${formatBytes(window.week)} this week · ${formatBytes(window.month)} in 30 days`
}

const limitsText = computed(() => {
  const limits = data.value?.limits
  if (!limits)
    return ''
  const parts = [
    limits.maxConcurrentUploadsPerPeer == null ? 'no per-friend slot limit' : `${limits.maxConcurrentUploadsPerPeer} upload slots per friend`,
    limits.dailyUploadLimitGiBPerPeer == null ? 'no daily limit' : `${limits.dailyUploadLimitGiBPerPeer} GB per friend per day`,
  ]
  return parts.join(' · ')
})
</script>

<template>
  <UDashboardPanel id="friends">
    <template #header>
      <UDashboardNavbar title="Friends" />
    </template>

    <template #body>
      <LoadErrorAlert v-if="error && !data" :error="error" :retry="refresh" />

      <p v-else-if="pending && !data" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <div v-else-if="data" class="space-y-6">
        <section class="space-y-2">
          <h2 class="text-sm font-medium text-highlighted">
            You download from
          </h2>
          <UCard v-if="data.peers.length === 0" variant="subtle" :ui="{ body: 'p-3 flex flex-wrap items-center justify-between gap-2' }">
            <p class="text-sm text-muted">
              No friends yet.
            </p>
            <UButton :to="settingsLink('peers')" label="Add a friend" icon="i-ph-plus" size="sm" variant="soft" />
          </UCard>
          <UCard v-for="peer in data.peers" :key="peer.id" variant="subtle" :ui="{ body: 'p-3 space-y-1.5' }">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium text-default">
                {{ peer.name }}
              </p>
              <UBadge :color="status(peer).color" variant="subtle" :label="status(peer).label" />
            </div>
            <p class="text-xs text-muted">
              {{ peer.url }}<span v-if="peer.version"> · jack {{ peer.version }}</span><span v-if="peer.lastSeenAt"> · last seen {{ formatAgo(peer.lastSeenAt) }}</span>
            </p>
            <p class="text-xs text-muted tabular-nums">
              Downloaded: {{ trafficLine(peer.downloaded) }}
            </p>
            <p v-if="peer.online === false && peer.lastError" class="text-xs text-error">
              {{ peer.lastError }}
            </p>
          </UCard>
        </section>

        <section class="space-y-2">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="text-sm font-medium text-highlighted">
              Can download from you
            </h2>
            <ULink :to="settingsLink('bandwidth')" class="text-xs text-muted underline">
              {{ limitsText }}
            </ULink>
          </div>
          <UCard v-if="data.keys.length === 0" variant="subtle" :ui="{ body: 'p-3 flex flex-wrap items-center justify-between gap-2' }">
            <p class="text-sm text-muted">
              Nobody can download from you yet.
            </p>
            <UButton :to="settingsLink('public-address')" label="Generate quick link" icon="i-ph-link" size="sm" variant="soft" />
          </UCard>
          <UCard v-for="key in data.keys" :key="key.id" variant="subtle" :ui="{ body: 'p-3 space-y-1.5' }">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium text-default">
                {{ key.name ?? `Key #${key.id}` }}
              </p>
              <UBadge v-if="key.activeUploads > 0" color="success" variant="subtle" :label="`${key.activeUploads} uploading now`" />
            </div>
            <p class="text-xs text-muted tabular-nums">
              Uploaded: {{ trafficLine(key.uploaded) }}
            </p>
          </UCard>
        </section>

        <IntroductionsPanel />

        <p class="text-xs text-muted">
          Reachability is checked every 5 minutes. Traffic is counted per server day and kept from the moment this jack started counting.
        </p>
      </div>
    </template>
  </UDashboardPanel>
</template>
