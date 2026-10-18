<script setup lang="ts">
// Settings saved since jack started that only apply after a restart of the jack
// container (overview.system.restartPending). The layout renders this once above
// every page, and it stays until jack has restarted.
const { overview } = useOverview()
const toast = useToast()

const labels = computed(() => restartReasonLabels(overview.value?.system?.restartPending ?? []))

// A new bootedAt means jack restarted while this page was open. "New settings are
// active" is only true when something was waiting for that restart.
watch(() => overview.value?.system, (system, previous) => {
  if (!system?.bootedAt || !previous?.bootedAt || system.bootedAt === previous.bootedAt)
    return
  if (previous.restartPending?.length)
    toast.add({ title: 'jack restarted. New settings are active.', color: 'success', icon: 'i-ph-check-circle' })
  else
    toast.add({ title: 'jack restarted.', color: 'neutral', icon: 'i-ph-arrow-clockwise' })
})
</script>

<template>
  <div
    v-if="labels.length"
    role="status"
    class="shrink-0 border-b border-warning/25 bg-warning/10 pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-2 pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(2rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))]"
  >
    <p class="flex items-start gap-2 text-sm text-default">
      <UIcon name="i-ph-arrow-clockwise" class="mt-0.5 size-4 shrink-0 text-warning" />
      <span class="min-w-0">
        <span class="font-medium text-highlighted">jack needs a restart to apply: {{ labels.join(', ') }}.</span>
        Unraid: <span class="whitespace-nowrap">{{ RESTART_STEPS }}</span>.
        <span class="text-muted">jack-ui doesn't need a restart.</span>
      </span>
    </p>
  </div>
</template>
