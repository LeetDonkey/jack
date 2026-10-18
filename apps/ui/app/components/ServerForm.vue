<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { SecretRef, ServerInput, ServerItem } from '~/types/management'

const props = defineProps<{
  initial?: ServerItem | null
  submitting?: boolean
  error?: string | null
}>()
// `dirty` lets the dialog refuse an outside click or Escape once something was edited.
const emit = defineEmits<{ submit: [ServerInput], cancel: [], dirty: [boolean] }>()

const editing = computed(() => Boolean(props.initial))

const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

// `null` means the config has no downloads block, so jack adds nothing to
// Radarr/Sonarr until downloads are turned on.
const { data: downloadsConfig } = useDownloadsConfig()
// restartPending lists 'downloads' when they were turned on after jack started:
// jack serves its download client only after a restart. An older jack sends no
// `system`.
const { overview } = useOverview()

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
  // 50 is the lowest priority, so jack never outranks the user's own indexers on a tie.
  autoPriority: props.initial?.autoregister?.priority ?? 50,
  upgradeMode: (!props.initial || props.initial.upgrades.allow ? (props.initial?.upgrades.maxSizeGiB == null ? 'all' : 'capped') : 'none') as 'all' | 'capped' | 'none',
  upgradeMaxGiB: (props.initial?.upgrades.maxSizeGiB ?? null) as number | null,
  headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
})

// The form as it opened; any difference counts as an edit.
const baseline = JSON.stringify(state)
const dirty = computed(() => JSON.stringify(state) !== baseline)
watch(dirty, isDirty => emit('dirty', isDirty), { immediate: true })

// Copy names the type picked above ("this Radarr"), not a generic *arr.
const arr = computed(() => arrName(state.type))
const showDownloadsAlert = computed(() => state.destination && downloadsConfig.value === null)
const showRestartAlert = computed(() => state.destination && downloadsConfig.value != null
  && (overview.value?.system?.restartPending.includes('downloads') ?? false))
const restartAlertTitle = computed(() => {
  const after = `After you restart the jack container, ${arr.value} gets jack's download client.`
  return editing.value ? after : `You can connect ${arr.value} now. ${after}`
})
// Saving waits for jack to add itself and for the *arr to test it. With downloads
// off jack adds nothing, so the save is quick.
const savingRegisters = computed(() => state.destination && state.autoEnable && downloadsConfig.value != null)

const isPriority = (value: number) => Number.isInteger(value) && value >= 1 && value <= 50
// Radarr and Sonarr API keys are 32 hex characters.
const API_KEY = /^[0-9a-f]{32}$/i

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

// Only visible fields are validated, so an error never points at a hidden one.
function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.name.trim())
    errors.push({ name: 'name', message: `Give this ${arr.value} a name.` })
  const url = s.url.trim()
  if (!url)
    errors.push({ name: 'url', message: `Enter the URL jack uses to reach ${arr.value}.` })
  else if (!isHttpUrl(url))
    errors.push({ name: 'url', message: `Start the URL with http:// or https://, for example http://192.168.1.10:${s.type === 'sonarr' ? 8989 : 7878}.` })
  if (!s.apiKey)
    errors.push({ name: 'apiKey', message: `Paste the API key from ${arr.value}.` })
  // A container variable or file is read by jack, so only a typed key can be checked.
  else if (typeof s.apiKey === 'string' && !API_KEY.test(s.apiKey))
    errors.push({ name: 'apiKey', message: `That doesn't look like a ${arr.value} API key. Copy it from ${arr.value} -> Settings -> General -> API Key.` })
  if (s.destination && s.autoEnable && !isPriority(s.autoPriority))
    errors.push({ name: 'autoPriority', message: 'Pick a priority from 1 to 50.' })
  if (s.destination && s.upgradeMode === 'capped' && !(s.upgradeMaxGiB != null && s.upgradeMaxGiB > 0))
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
    // The API rejects a priority outside 1-50 even when it's unused, and a hidden
    // field skipped validation.
    autoregister: { enable: state.autoEnable, priority: isPriority(state.autoPriority) ? state.autoPriority : 50 },
    upgrades: { allow: state.upgradeMode !== 'none', maxSizeGiB: state.upgradeMode === 'capped' ? state.upgradeMaxGiB : null },
  }
  if (Object.keys(state.headers).length)
    input.headers = state.headers
  emit('submit', input)
}
</script>

<template>
  <UForm ref="form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit" @error="onError">
    <UAlert
      v-if="showDownloadsAlert"
      color="warning"
      variant="soft"
      icon="i-ph-warning"
      :title="`Turn on downloads first, or jack can't add its download client to this ${arr}.`"
      :actions="[{ label: 'Turn on downloads', color: 'warning', variant: 'outline', to: settingsLink('downloads'), onClick: () => emit('cancel') }]"
    />
    <UAlert
      v-else-if="showRestartAlert"
      color="info"
      variant="soft"
      icon="i-ph-info"
      :title="restartAlertTitle"
    />

    <UFormField name="name" label="Name" required>
      <UInput v-model="state.name" :placeholder="arr" class="w-full" />
    </UFormField>

    <div class="flex gap-3">
      <UFormField name="url" label="URL" required class="flex-1">
        <template #hint>
          <ULink
            :to="docsUrl('unraid', '5-connect-radarr-and-sonarr')"
            target="_blank"
            class="inline-flex items-center gap-1 text-xs"
          >
            <UIcon name="i-ph-question" class="size-3.5" />
            Help
          </ULink>
        </template>
        <UInput v-model="state.url" :placeholder="state.type === 'sonarr' ? 'http://sonarr:8989' : 'http://radarr:7878'" class="w-full" />
      </UFormField>
      <UFormField name="type" label="Type">
        <USelect v-model="state.type" :items="typeItems" class="w-32" />
      </UFormField>
    </div>

    <UFormField name="apiKey" label="API key" :description="`In ${arr}: Settings -> General -> API Key.`" required>
      <SecretInput v-model="state.apiKey" placeholder="Paste the API key" />
    </UFormField>

    <div class="space-y-3">
      <UFormField name="source">
        <USwitch
          v-model="state.source"
          :label="`Share this ${arr}'s library with friends`"
          description="Friends can see and download what it has."
        />
      </UFormField>
      <UFormField name="destination">
        <USwitch
          v-model="state.destination"
          :label="`Download from friends into this ${arr}`"
          :description="`Adds jack as an indexer and download client in ${arr}.`"
        />
      </UFormField>
    </div>

    <!-- Registration and the upgrade policy only apply to a server that receives downloads. -->
    <template v-if="state.destination">
      <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
        <UCheckbox v-model="state.autoEnable" :label="`Auto-register jack in this ${arr}`" />
        <UFormField
          v-if="state.autoEnable"
          name="autoPriority"
          label="Indexer priority"
          :description="`1 = most preferred, 50 = least. With 50 your other indexers win when releases are otherwise equal. Saving applies it to ${arr} right away.`"
        >
          <UInputNumber v-model="state.autoPriority" :min="1" :max="50" class="w-24" />
        </UFormField>
      </UCard>

      <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
        <UFormField
          name="upgradeMode"
          label="Releases from friends"
          :description="`For movies and episodes this ${arr} already has. Missing ones are always offered.`"
        >
          <URadioGroup v-model="state.upgradeMode" :items="upgradeItems" />
        </UFormField>
        <UFormField v-if="state.upgradeMode === 'capped'" name="upgradeMaxGiB" label="Largest upgrade" hint="GB" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
          <UInputNumber v-model="state.upgradeMaxGiB" :min="1" :step="1" :increment="false" :decrement="false" class="w-24" />
        </UFormField>
      </UCard>
    </template>

    <UFormField label="Headers" hint="Optional">
      <HeadersEditor v-model="state.headers" />
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
      <p v-if="showFixHint" class="text-xs text-error">
        Fix the highlighted fields to save.
      </p>
      <p v-else-if="submitting && savingRegisters" class="text-xs text-muted">
        Waiting for {{ arr }} to test jack. This can take up to 30 seconds.
      </p>
      <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('cancel')" />
      <UButton type="submit" :loading="submitting" :label="submitting ? (savingRegisters ? 'Connecting and testing…' : 'Saving…') : editing ? 'Save changes' : `Connect ${arr}`" />
    </div>
  </UForm>
</template>
