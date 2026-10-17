<script setup lang="ts">
import type { TorznabConfig, TorznabConfigPatch } from '~/types/management'

const { request, extractError } = useManagement()

const { data: torznab, pending, error: loadError, refresh } = useLazyAsyncData(
  'torznab-config',
  () => request<TorznabConfig | null>('config/torznab'),
)

const DEFAULTS = { rssMaxAgeDays: 7, rssMaxItems: 100 }

// null means "use jack's default"; the GET returns defaults applied, so a value
// equal to the default is shown as empty.
function blankState() {
  return { rssMaxAgeDays: null as number | null, rssMaxItems: null as number | null }
}

const state = reactive(blankState())
const baseline = ref(JSON.stringify(blankState()))

function seed(config: TorznabConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    state.rssMaxAgeDays = config.rssMaxAgeDays === DEFAULTS.rssMaxAgeDays ? null : config.rssMaxAgeDays
    state.rssMaxItems = config.rssMaxItems === DEFAULTS.rssMaxItems ? null : config.rssMaxItems
  }
  baseline.value = JSON.stringify(state)
}

watch(() => torznab.value, seed, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== baseline.value)
const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  const patch: TorznabConfigPatch = { rssMaxAgeDays: state.rssMaxAgeDays, rssMaxItems: state.rssMaxItems }
  try {
    await request('config/torznab', { method: 'PATCH', body: patch })
    await refresh()
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the RSS feed settings.')
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(torznab.value ?? null)
  saveError.value = null
  saved.value = false
}
</script>

<template>
  <SettingsSection
    title="RSS feed"
    description="What your Radarr/Sonarr see on every RSS sync. Searches (a new movie, a request, a manual search) always look through every friend's whole library."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the RSS feed settings." />

    <p v-else-if="pending && torznab === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else :state="state" class="space-y-3" @submit="save">
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <ConfigNumberField
          v-model="state.rssMaxAgeDays"
          :disabled="saving"
          name="rssMaxAgeDays"
          label="Newest releases only"
          description="Days back a friend's file may have been added and still appear in the feed. A feed of every friend's whole library lets *arr grab every possible upgrade in one sync."
          :default-value="DEFAULTS.rssMaxAgeDays"
          :min="1"
        />
        <ConfigNumberField
          v-model="state.rssMaxItems"
          :disabled="saving"
          name="rssMaxItems"
          label="Most releases per sync"
          description="The newest ones are kept."
          :default-value="DEFAULTS.rssMaxItems"
          :min="1"
        />
      </UCard>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="The next RSS sync uses these settings." />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <p class="mr-auto text-xs text-muted">
          Clear a field to use jack's default.
        </p>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
