<script setup lang="ts">
// Shown above every page by the layout while useOverview counts jack as down: the
// overview stream, which had connected, has been closed for a while (visible time
// only). Until then the pages keep what jack last sent, with only a small
// "Reconnecting…" badge. The stream reopens by itself, and the notice goes as
// soon as it is back. Pages that read the same jackDown change with this notice.
const { jackDown } = useOverview()
</script>

<template>
  <div
    v-if="jackDown"
    role="status"
    class="shrink-0 border-b border-warning/25 bg-warning/10 pt-2 pr-[max(1rem,env(safe-area-inset-right))] pb-2 pl-[max(1rem,env(safe-area-inset-left))] first:pt-[max(0.5rem,env(safe-area-inset-top))] sm:pr-[max(2rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))]"
  >
    <p class="flex items-start gap-2 text-sm text-default">
      <UIcon name="i-ph-plugs" class="mt-0.5 size-4 shrink-0 text-warning" />
      <span class="min-w-0">
        <span class="font-medium text-highlighted">jack isn't answering.</span>
        It may be restarting, and this page updates by itself once jack is back.
        If it stays like this, check that the jack container is running (Docker tab).
      </span>
    </p>
  </div>
</template>
