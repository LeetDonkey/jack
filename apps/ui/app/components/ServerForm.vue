<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { SecretRef, ServerInput, ServerItem } from '~/types/management'

const props = defineProps<{
  initial?: ServerItem | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [ServerInput], cancel: [] }>()

const editing = computed(() => Boolean(props.initial))

const typeItems = [
  { label: 'Radarr', value: 'radarr' },
  { label: 'Sonarr', value: 'sonarr' },
]

const upgradeItems = [
  { label: 'Also offer upgrades', value: 'all' },
  { label: 'Offer upgrades up to a size', value: 'capped' },
  { label: 'Only offer what is missing', value: 'none' },
]

const state = reactive({
  name: props.initial?.name ?? '',
  url: props.initial?.url ?? '',
  type: (props.initial?.type as 'radarr' | 'sonarr') ?? 'radarr',
  apiKey: (props.initial?.apiKey ?? null) as SecretRef | null,
  source: props.initial?.source ?? true,
  destination: props.initial?.destination ?? true,
  autoEnable: props.initial?.autoregister?.enable ?? true,
  autoPriority: props.initial?.autoregister?.priority ?? 1,
  upgradeMode: (!props.initial || props.initial.upgrades.allow ? (props.initial?.upgrades.maxSizeGiB == null ? 'all' : 'capped') : 'none') as 'all' | 'capped' | 'none',
  upgradeMaxGiB: (props.initial?.upgrades.maxSizeGiB ?? null) as number | null,
  headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
})

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.name.trim())
    errors.push({ name: 'name', message: 'Give the server a name.' })
  if (!s.url.trim())
    errors.push({ name: 'url', message: 'Enter the server URL.' })
  if (!s.apiKey)
    errors.push({ name: 'apiKey', message: 'An API key is required.' })
  if (s.autoEnable && (!Number.isInteger(s.autoPriority) || s.autoPriority < 1 || s.autoPriority > 50))
    errors.push({ name: 'autoPriority', message: 'Pick a priority from 1 to 50.' })
  if (s.upgradeMode === 'capped' && !(s.upgradeMaxGiB != null && s.upgradeMaxGiB > 0))
    errors.push({ name: 'upgradeMaxGiB', message: 'Enter the largest upgrade to fetch, in GB.' })
  return errors
}

function onSubmit() {
  const input: ServerInput = {
    name: state.name.trim(),
    url: state.url.trim(),
    type: state.type,
    apiKey: state.apiKey!,
    source: state.source,
    destination: state.destination,
    autoregister: { enable: state.autoEnable, priority: state.autoPriority },
    upgrades: { allow: state.upgradeMode !== 'none', maxSizeGiB: state.upgradeMode === 'capped' ? state.upgradeMaxGiB : null },
  }
  if (Object.keys(state.headers).length)
    input.headers = state.headers
  emit('submit', input)
}
</script>

<template>
  <UForm :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
    <UFormField name="name" label="Name" required>
      <UInput v-model="state.name" placeholder="Radarr" class="w-full" />
    </UFormField>

    <div class="flex gap-3">
      <UFormField name="url" label="URL" required class="flex-1">
        <UInput v-model="state.url" placeholder="http://radarr:7878" class="w-full" />
      </UFormField>
      <UFormField name="type" label="Type">
        <USelect v-model="state.type" :items="typeItems" class="w-32" />
      </UFormField>
    </div>

    <UFormField name="apiKey" label="API key" description="*arr API keys are 32-character hex." required>
      <SecretInput v-model="state.apiKey" :editing="editing" />
    </UFormField>

    <div class="flex gap-6">
      <UFormField name="source">
        <UCheckbox v-model="state.source" label="Source" />
      </UFormField>
      <UFormField name="destination">
        <UCheckbox v-model="state.destination" label="Destination" />
      </UFormField>
    </div>

    <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
      <UCheckbox v-model="state.autoEnable" label="Auto-register jack in this *arr" />
      <UFormField
        v-if="state.autoEnable"
        name="autoPriority"
        label="Indexer priority"
        description="1 (highest) to 50 (lowest). When two releases are otherwise equal, *arr grabs from the indexer with the lower number. Saving applies it to *arr right away."
      >
        <UInputNumber v-model="state.autoPriority" :min="1" :max="50" class="w-24" />
      </UFormField>
    </UCard>

    <UCard v-if="state.destination" variant="subtle" :ui="{ body: 'space-y-3' }">
      <UFormField
        name="upgradeMode"
        label="Releases from friends"
        description="For movies and episodes this *arr already has. Missing ones are always offered."
      >
        <URadioGroup v-model="state.upgradeMode" :items="upgradeItems" />
      </UFormField>
      <UFormField v-if="state.upgradeMode === 'capped'" name="upgradeMaxGiB" label="Largest upgrade" hint="GB" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
        <UInputNumber v-model="state.upgradeMaxGiB" :min="1" :step="1" :increment="false" :decrement="false" class="w-24" />
      </UFormField>
    </UCard>

    <UFormField label="Headers" hint="Optional">
      <HeadersEditor v-model="state.headers" />
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex justify-end gap-2 pt-2">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('cancel')" />
      <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : editing ? 'Save changes' : 'Add server'" />
    </div>
  </UForm>
</template>
