<script setup lang="ts">
// Navbar badge for a page fed by useManagementStream. Before the first open it is
// neutral ("Connecting…"); the warning only appears after a connection dropped.
// `paused` is for a page that lets the user stop the stream (Logs).
const props = defineProps<{
  connected: boolean
  hasConnectedOnce: boolean
  paused?: boolean
}>()

const badge = computed(() => {
  if (props.paused)
    return { label: 'Paused', color: 'neutral' as const, icon: 'i-ph-pause' }
  if (props.connected)
    return { label: 'Live', color: 'success' as const, icon: 'i-ph-broadcast' }
  return props.hasConnectedOnce
    ? { label: 'Reconnecting…', color: 'warning' as const, icon: 'i-ph-broadcast' }
    : { label: 'Connecting…', color: 'neutral' as const, icon: 'i-ph-broadcast' }
})
</script>

<template>
  <UBadge :color="badge.color" variant="subtle" :icon="badge.icon" :label="badge.label" />
</template>
