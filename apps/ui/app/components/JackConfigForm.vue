<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { JackConfig } from '~/types/management'

const props = defineProps<{
  initial?: JackConfig | null
  submitting?: boolean
  error?: string | null
  saved?: boolean
}>()
const emit = defineEmits<{ submit: [JackConfig] }>()

const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

// Only the address is edited here. PATCH /config/jack merges, so keys that are
// still set in config.jsonc (the deprecated main API key, a TMDB key) are kept.
function initialState() {
  return { internalUrl: props.initial?.internalUrl ?? '' }
}

const state = reactive(initialState())
// The parent re-keys this form after a save, so the saved config is the baseline
// and Save stays disabled until the address differs from it.
const baseline = JSON.stringify(initialState())
const dirty = computed(() => JSON.stringify(state) !== baseline)
useUnsavedGuard().track('the address Radarr/Sonarr use to reach jack', dirty)

// The confirmation belongs to the saved value; editing again retires it.
const showSaved = computed(() => props.saved && !dirty.value)

// The form doesn't check a value set in code again, so an error from a failed
// submit would stay on the saved address.
function revert() {
  Object.assign(state, initialState())
  form.value?.clear()
}

// The default name only resolves for containers on the jack Docker network. When
// the UI is opened by IP, that IP is most likely the Unraid server, which
// publishes jack's port 5225 unless the template changed it.
const hostname = useRequestURL().hostname
const suggestedUrl = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) && !hostname.startsWith('127.')
  ? `http://${hostname}:5225`
  : null
const isDefaultUrl = computed(() => isDefaultInternalUrl(state.internalUrl))
function applySuggestedUrl() {
  if (suggestedUrl)
    state.internalUrl = suggestedUrl
}

const guideUrl = docsUrl('unraid', '5-connect-radarr-and-sonarr')

function validate(s: typeof state): FormError[] {
  const url = s.internalUrl.trim()
  if (!url)
    return [{ name: 'internalUrl', message: 'Enter the address Radarr/Sonarr use to reach jack.' }]
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  }
  catch {}
  if (protocol !== 'http:' && protocol !== 'https:')
    return [{ name: 'internalUrl', message: 'Start the address with http:// or https://, for example http://192.168.1.10:5225.' }]
  return []
}

function onSubmit() {
  emit('submit', { internalUrl: state.internalUrl.trim() })
}
</script>

<template>
  <UForm ref="form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit" @error="onError">
    <UFormField
      name="internalUrl"
      label="Address Radarr/Sonarr use to reach jack"
      description="Usually http://YOUR-UNRAID-IP:5225. Keep http://jack:5225 only if Radarr and Sonarr are on the jack Docker network."
      required
    >
      <template #hint>
        <UButton :to="guideUrl" target="_blank" label="Help" icon="i-ph-question" color="neutral" variant="link" size="xs" class="p-0" />
      </template>
      <UInput v-model="state.internalUrl" :disabled="submitting" placeholder="http://192.168.1.10:5225" class="w-full" />
      <template v-if="isDefaultUrl" #help>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span class="flex items-center gap-1.5 text-warning">
            <UIcon name="i-ph-warning" class="size-4 shrink-0" />
            Still the default. Change it unless Radarr and Sonarr are on the jack Docker network.
          </span>
          <UButton
            v-if="suggestedUrl"
            :label="`Use ${suggestedUrl} (if you kept port 5225)`"
            size="xs"
            color="warning"
            variant="soft"
            :disabled="submitting"
            :ui="{ base: 'max-w-full', label: 'whitespace-normal text-left' }"
            @click="applySuggestedUrl"
          />
        </div>
      </template>
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
    <UAlert
      v-else-if="showSaved"
      color="success"
      variant="soft"
      icon="i-ph-check-circle"
      title="Saved. jack updates Radarr/Sonarr with the new address."
    />

    <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
      <p v-if="showFixHint" class="mr-auto text-xs text-error">
        Fix the highlighted field to save.
      </p>
      <p v-else class="mr-auto text-xs text-muted">
        Applies right away: jack updates Radarr/Sonarr when you save.
      </p>
      <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="submitting" @click="revert" />
      <UButton type="submit" :disabled="!dirty" :loading="submitting" :label="submitting ? 'Saving…' : 'Save changes'" />
    </div>
  </UForm>
</template>
