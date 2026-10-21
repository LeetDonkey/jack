<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { SecretRef } from '~/types/management'

const props = defineProps<{ modelValue: Record<string, SecretRef> }>()
const emit = defineEmits<{ 'update:modelValue': [Record<string, SecretRef>] }>()

// `id` keys the row: SecretInput copies its value once, so an index key would
// show a removed row's value in the row that moved up. `stored` marks a header
// that came with a value, where an empty value removes the header on save.
interface Row { id: number, key: string, value: SecretRef | null, stored: boolean }

let nextId = 0
const rows = ref<Row[]>(
  Object.entries(props.modelValue ?? {}).map(([key, value]) => ({ id: nextId++, key, value, stored: true })),
)

const isEmpty = (value: SecretRef | null) => value === null || value === ''
// A row's errors go to fields of their own: headers.<row id> under the value,
// headers.<row id>.name under the name. HEADER_ROW in the forms matches both.
const fieldName = (row: Row) => `headers.${row.id}`
const nameFieldName = (row: Row) => `headers.${row.id}.name`

function sync() {
  const out: Record<string, SecretRef> = {}
  for (const row of rows.value) {
    const k = row.key.trim()
    // Rows without a name or a value aren't headers (yet). A stored header with
    // its value cleared is left out, which removes it.
    if (k && !isEmpty(row.value))
      out[k] = row.value!
  }
  emit('update:modelValue', out)
}

function add() {
  rows.value.push({ id: nextId++, key: '', value: null, stored: false })
}
function remove(index: number) {
  rows.value.splice(index, 1)
  sync()
}

watch(rows, sync, { deep: true })

/**
 * Rows that sync() would drop without a word, as errors on their fields: a new
 * header with a name but no value, and any header with a value but no name
 * (pasting the value first is common). The parent's `validate` adds these, so
 * saving waits for the missing part or for the row to go.
 */
const errors = computed<FormError[]>(() => rows.value.flatMap((row) => {
  const named = row.key.trim() !== ''
  if (!named && !isEmpty(row.value))
    return [{ name: nameFieldName(row), message: 'Enter a name or remove the header.' }]
  if (named && !row.stored && isEmpty(row.value))
    return [{ name: fieldName(row), message: 'Enter a value or remove the header.' }]
  return []
}))

defineExpose({ errors })
</script>

<template>
  <div class="space-y-2">
    <div v-for="(row, index) in rows" :key="row.id" class="flex items-start gap-2">
      <!-- Each error shows under the part it asks for. -->
      <UFormField :name="nameFieldName(row)" class="w-1/3 shrink-0">
        <UInput v-model="row.key" placeholder="Header" class="w-full" />
      </UFormField>
      <UFormField :name="fieldName(row)" class="min-w-0 flex-1">
        <SecretInput v-model="row.value" placeholder="Value" optional cleared-hint="Saving with this empty removes the header." />
      </UFormField>
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-ph-x"
        aria-label="Remove header"
        @click="remove(index)"
      />
    </div>
    <UButton variant="link" size="sm" icon="i-ph-plus" label="Add header" class="px-0" @click="add" />
  </div>
</template>
