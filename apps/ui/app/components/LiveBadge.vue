<script setup lang="ts">
// Navbar badge for a page fed by useManagementStream. Before the first open it is
// neutral ("Connecting…"); the warning only appears after a connection dropped.
const props = defineProps<{
  connected: boolean
  hasConnectedOnce: boolean
}>()

const badge = computed(() => {
  if (props.connected)
    return { label: 'Live', color: 'success' as const }
  return props.hasConnectedOnce
    ? { label: 'Reconnecting…', color: 'warning' as const }
    : { label: 'Connecting…', color: 'neutral' as const }
})
</script>

<template>
  <UBadge :color="badge.color" variant="subtle" icon="i-ph-broadcast" :label="badge.label" />
</template>
