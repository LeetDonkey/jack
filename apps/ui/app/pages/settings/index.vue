<script setup lang="ts">
import type { JackConfig } from '~/types/management'

// Settings > Radarr & Sonarr: what jack needs before Radarr and Sonarr can use it,
// in setup order.
const { request, extractError } = useManagement()

// Surface pending/error so a failed GET never renders a blank form a user could
// accidentally save over.
const { data: jack, pending, error: loadError, refresh } = useJackConfig()

const submitting = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
const formRevision = ref(0)

async function save(input: JackConfig) {
  submitting.value = true
  saveError.value = null
  saved.value = false
  try {
    await request('config/jack', { method: 'PATCH', body: input })
    await refresh()
    formRevision.value++
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the address.')
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="space-y-10">
    <SettingsSection
      id="internal-url"
      title="Address Radarr/Sonarr use to reach jack"
      description="Radarr and Sonarr search your friends' libraries and hand downloads to jack at this address."
    >
      <UAlert v-if="loadError && jack === undefined" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the address." />

      <!-- Only on the first load. A save refreshes the config too, and hiding the
           form then would flash the card. -->
      <p v-else-if="pending && jack === undefined" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <UCard v-else variant="subtle" :ui="{ body: 'space-y-4' }">
        <!-- Re-key after a successful refresh so the form seeds its state from the saved config. -->
        <JackConfigForm
          :key="formRevision"
          :initial="jack"
          :submitting="submitting"
          :error="saveError"
          :saved="saved"
          @submit="save"
        />
      </UCard>
    </SettingsSection>

    <USeparator />

    <DownloadsSection />

    <USeparator />

    <ServersSection />
  </div>
</template>
