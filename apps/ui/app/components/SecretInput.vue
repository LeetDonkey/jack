<script setup lang="ts">
import type { SecretRef } from '~/types/management'

const props = withDefaults(defineProps<{
  modelValue: SecretRef | null
  // The prompt in the empty field, e.g. "Paste the API key".
  placeholder?: string
  // The field may be left empty. Clearing a stored value then shows `clearedHint`;
  // a required field gets the form's own error instead.
  optional?: boolean
  // What saving with an optional field cleared does, in the caller's words.
  clearedHint?: string
}>(), { clearedHint: 'Saving with this field empty removes the stored value.' })
const emit = defineEmits<{ 'update:modelValue': [SecretRef | null] }>()

type Mode = 'literal' | 'env' | 'file'

const modeItems = [
  { label: 'Typed here', value: 'literal' },
  { label: 'Container variable', value: 'env' },
  { label: 'File in the container', value: 'file' },
]

function detectMode(v: SecretRef | null): Mode {
  if (v && typeof v === 'object')
    return 'env' in v ? 'env' : 'file'
  return 'literal'
}
function detectValue(v: SecretRef | null): string {
  if (typeof v === 'string')
    return v
  if (v && 'env' in v)
    return v.env
  if (v && 'file' in v)
    return v.file
  return ''
}

// GET /config returns refs intact, so an edit form prefills this with the stored
// value or ref. It is copied once; a parent that reloads remounts this.
const mode = ref<Mode>(detectMode(props.modelValue))
// One value per mode, so switching to Container variable never shows a typed
// secret as plain text, and switching back restores it.
const values = reactive<Record<Mode, string>>({ literal: '', env: '', file: '' })
values[mode.value] = detectValue(props.modelValue)
const hadValue = values[mode.value] !== ''

// Most people type the value, so the source picker stays folded away unless
// the stored value already comes from a variable or file.
const showSource = ref(mode.value !== 'literal')

// The link that unfolds the picker disappears with the click, so focus moves to
// the picker rather than falling back to the page.
const sourceSelect = useTemplateRef<{ triggerRef: HTMLButtonElement | null }>('sourceSelect')
async function unfoldSource() {
  showSource.value = true
  await nextTick()
  sourceSelect.value?.triggerRef?.focus()
}

// Typed secrets are masked until the eye is clicked. Variable names and paths
// aren't secret, so they always show.
const reveal = ref(false)
const inputType = computed(() => (mode.value === 'literal' && !reveal.value ? 'password' : 'text'))

const inputPlaceholder = computed(() => {
  if (mode.value === 'env')
    return 'Variable name, e.g. MY_SECRET'
  if (mode.value === 'file')
    return 'Path, e.g. /run/secrets/key'
  return props.placeholder ?? 'Paste the value'
})

const cleared = computed(() => props.optional && hadValue && values[mode.value].trim() === '')

watch(() => [mode.value, values[mode.value]] as const, ([m, raw]) => {
  const v = raw.trim()
  if (!v)
    emit('update:modelValue', null)
  else if (m === 'env')
    emit('update:modelValue', { env: v })
  else if (m === 'file')
    emit('update:modelValue', { file: v })
  else
    emit('update:modelValue', v)
})
</script>

<template>
  <div class="space-y-1">
    <div class="flex flex-wrap gap-2">
      <!-- A nameless field of its own keeps the select off the outer field's
           label and validation, which belong to the input. -->
      <UFormField v-if="showSource" class="w-full sm:w-48 sm:shrink-0">
        <USelect ref="sourceSelect" v-model="mode" :items="modeItems" aria-label="Where the value comes from" class="w-full" />
      </UFormField>
      <UInput
        v-model="values[mode]"
        :type="inputType"
        :placeholder="inputPlaceholder"
        autocomplete="off"
        class="min-w-40 flex-1"
      >
        <template v-if="mode === 'literal'" #trailing>
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            :icon="reveal ? 'i-ph-eye-slash' : 'i-ph-eye'"
            :aria-label="reveal ? 'Hide value' : 'Show value'"
            @click="() => { reveal = !reveal }"
          />
        </template>
      </UInput>
    </div>
    <p v-if="cleared" class="text-xs text-warning">
      {{ clearedHint }}
    </p>
    <!-- Wraps in a narrow column, such as a header row's value on a phone. -->
    <UButton
      v-if="!showSource"
      variant="link"
      color="neutral"
      size="xs"
      label="Use a container variable or file instead"
      class="max-w-full px-0"
      :ui="{ label: 'whitespace-normal text-left' }"
      @click="unfoldSource"
    />
  </div>
</template>
