<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { JackConfig, SecretRef } from '~/types/management'

const props = defineProps<{
  initial?: JackConfig | null
  submitting?: boolean
  error?: string | null
  // Whether the TMDB key jack is running with authenticates (catalog/tmdb/status).
  tmdbStatus?: { configured: boolean, ok: boolean } | null
}>()
const emit = defineEmits<{ submit: [JackConfig] }>()

const state = reactive({
  internalUrl: props.initial?.internalUrl ?? '',
  apiKey: (props.initial?.apiKey ?? null) as SecretRef | null,
  tmdbApiKey: (props.initial?.tmdbApiKey ?? null) as SecretRef | null,
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

// Extras start collapsed on a fresh install. They open when a TMDB key is stored,
// or when a settingsLink('tmdb') points here.
const route = useRoute()
const extrasOpen = ref(Boolean(props.initial?.tmdbApiKey) || route.hash === '#tmdb')
watch(() => route.hash, (hash) => {
  if (hash === '#tmdb')
    extrasOpen.value = true
})

// internalUrl is the only required field; the secrets are optional/clearable.
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
  const input: JackConfig = { internalUrl: state.internalUrl.trim() }
  // SecretInput emits null when cleared → omit the key entirely (optional).
  if (state.apiKey)
    input.apiKey = state.apiKey
  if (state.tmdbApiKey)
    input.tmdbApiKey = state.tmdbApiKey
  emit('submit', input)
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

    <!-- The deprecated single key: shown only while one is configured, so it can be cleared. -->
    <div v-if="initial?.apiKey" class="space-y-3 rounded-md bg-warning/10 p-3 ring ring-inset ring-warning/25">
      <div class="flex gap-2">
        <UIcon name="i-ph-warning" class="mt-0.5 size-4 shrink-0 text-warning" />
        <p class="min-w-0 text-sm text-muted">
          You still use the old single key. Give each friend their own key (quick links do this), then clear this field and save.
        </p>
      </div>
      <UFormField name="apiKey" label="Main API key">
        <SecretInput v-model="state.apiKey" editing />
      </UFormField>
    </div>

    <div id="tmdb" class="scroll-mt-6">
      <UCollapsible v-model:open="extrasOpen">
        <UButton
          color="neutral"
          variant="subtle"
          block
          :ui="{ label: 'flex-1 text-left' }"
          label="Extras"
          :icon="extrasOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
        >
          <template #trailing>
            <span v-if="initial?.tmdbApiKey" class="text-xs text-muted">TMDB API key set</span>
          </template>
        </UButton>

        <template #content>
          <UFormField name="tmdbApiKey" label="TMDB API key" hint="Optional" class="pt-4">
            <SecretInput v-model="state.tmdbApiKey" :editing="Boolean(initial?.tmdbApiKey)" />
            <template #help>
              <p>Fills in posters and descriptions in Friends' library for titles a friend's older jack sends without them.</p>
              <p class="mt-1 flex items-center gap-1.5">
                <template v-if="tmdbStatus?.ok">
                  <UIcon name="i-ph-check-circle" class="size-4 shrink-0 text-success" />
                  TMDB accepts the key jack is using.
                </template>
                <template v-else-if="tmdbStatus?.configured">
                  <UIcon name="i-ph-warning" class="size-4 shrink-0 text-warning" />
                  jack has a TMDB API key, but TMDB doesn't accept it or can't be reached. Check the key, save and restart the jack container.
                </template>
                <template v-else>
                  <UIcon name="i-ph-info" class="size-4 shrink-0 text-dimmed" />
                  jack isn't using a TMDB key.
                </template>
              </p>
            </template>
          </UFormField>
        </template>
      </UCollapsible>
    </div>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
      <p class="mr-auto text-xs text-muted">
        Changes apply after you restart the jack container.
      </p>
      <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : 'Save'" />
    </div>
  </UForm>
</template>
