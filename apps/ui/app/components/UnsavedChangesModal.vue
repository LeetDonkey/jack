<script setup lang="ts">
// Opened through useOverlay() by useUnsavedGuard. Closing it any other way
// (Escape, the X) resolves undefined, which the guard reads as Stay.
const props = defineProps<{
  // Names of the sections with unsaved changes, e.g. ["Downloads", "Bandwidth"].
  labels: string[]
}>()
const emit = defineEmits<{ close: [leave: boolean] }>()

const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
const title = computed(() => `Leave without saving ${list.format(props.labels)}?`)
</script>

<template>
  <UModal :title="title" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        Changes you haven't saved are lost when you leave this page.
      </p>
    </template>
    <template #footer>
      <UButton label="Stay" color="neutral" variant="ghost" @click="emit('close', false)" />
      <UButton label="Leave without saving" color="error" @click="emit('close', true)" />
    </template>
  </UModal>
</template>
