<script setup lang="ts">
// Stored entries of an address list that jack ignores (Settings -> Sharing ->
// Security): a name such as "Nginx Proxy Manager" written by hand or by an older
// jack. They aren't in the field, so this line says what jack skips. Any save of
// the security settings drops every ignored entry from config.jsonc, in all fields
// at once, so the line says that rather than offer a choice per field.
const props = defineProps<{
  values: string[]
  // Names the field when the field itself is hidden.
  label?: string
}>()

const prefix = computed(() => props.label ? `${props.label}: ` : '')
</script>

<template>
  <p v-if="values.length" class="flex items-start gap-1.5 text-xs">
    <UIcon name="i-ph-warning" class="mt-px size-3.5 shrink-0 text-warning" />
    <span class="min-w-0 break-words text-warning">{{ prefix }}{{ ignoredEntriesNote(values) }}</span>
  </p>
</template>
