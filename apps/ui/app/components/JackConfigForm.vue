<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { JackConfig } from '~/types/management'

const props = defineProps<{
  initial?: JackConfig | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [JackConfig] }>()

// Only the address is edited here. PATCH /config/jack merges, so keys that are
// still set in config.jsonc (the deprecated main API key, a TMDB key) are kept.
const state = reactive({
  internalUrl: props.initial?.internalUrl ?? '',
})

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
  <UForm :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
    <UFormField
      name="internalUrl"
      label="Address Radarr/Sonarr use to reach jack"
      description="Usually http://YOUR-UNRAID-IP:5225. Keep http://jack:5225 only if Radarr and Sonarr are on the jack Docker network."
      required
    >
      <UInput v-model="state.internalUrl" placeholder="http://192.168.1.10:5225" class="w-full" />
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
            :ui="{ base: 'max-w-full', label: 'whitespace-normal text-left' }"
            @click="applySuggestedUrl"
          />
        </div>
      </template>
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
      <p class="mr-auto text-xs text-muted">
        Applies right away: jack updates Radarr/Sonarr when you save.
      </p>
      <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : 'Save'" />
    </div>
  </UForm>
</template>
