<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { NotificationsConfig, NotificationWebhook, SecretRef } from '~/types/management'

const { request, extractError } = useManagement()

const { data: notifications, pending, error: loadError, refresh } = useLazyAsyncData(
  'notifications-config',
  () => request<NotificationsConfig | null>('config/notifications'),
)

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

const typeItems = [
  { label: 'Discord webhook', value: 'discord' },
  { label: 'ntfy topic', value: 'ntfy' },
  { label: 'JSON (e.g. Home Assistant)', value: 'json' },
]

interface WebhookState {
  type: NotificationWebhook['type']
  url: SecretRef | null
}

function blankState() {
  return {
    webhooks: [] as WebhookState[],
    downloadFailed: true,
    peerOffline: true,
    ipBanned: true,
    peerOfflineMinutes: null as number | null,
    dailySummaryAt: '',
  }
}

type State = ReturnType<typeof blankState>

const state = reactive(blankState())
const baseline = ref(JSON.stringify(blankState()))
// Bumped on every seed so the SecretInputs (which copy their value once) remount.
const seedVersion = ref(0)

function seed(config: NotificationsConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    state.webhooks = (config.webhooks ?? []).map(w => ({ type: w.type, url: w.url }))
    state.downloadFailed = config.downloadFailed ?? true
    state.peerOffline = config.peerOffline ?? true
    state.ipBanned = config.ipBanned ?? true
    state.peerOfflineMinutes = config.peerOfflineMinutes ?? null
    state.dailySummaryAt = config.dailySummaryAt ?? ''
  }
  baseline.value = JSON.stringify(state)
  seedVersion.value++
}

watch(() => notifications.value, seed, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== baseline.value)
const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

function validate(s: State): FormError[] {
  const errors: FormError[] = []
  s.webhooks.forEach((w, i) => {
    if (w.url == null || w.url === '')
      errors.push({ name: `webhooks.${i}`, message: `Webhook ${i + 1}: enter its URL.` })
  })
  if (s.dailySummaryAt && !TIME.test(s.dailySummaryAt))
    errors.push({ name: 'dailySummaryAt', message: 'Enter the summary time as HH:MM.' })
  return errors
}

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  try {
    await request('config/notifications', {
      method: 'PATCH',
      body: {
        webhooks: state.webhooks.map(w => ({ type: w.type, url: w.url })),
        // On is the default, so write it as an absent key.
        downloadFailed: state.downloadFailed ? null : false,
        peerOffline: state.peerOffline ? null : false,
        ipBanned: state.ipBanned ? null : false,
        peerOfflineMinutes: state.peerOfflineMinutes,
        dailySummaryAt: state.dailySummaryAt || null,
      },
    })
    await refresh()
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the notification settings.')
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(notifications.value ?? null)
  saveError.value = null
  saved.value = false
}

const testing = ref(false)
const testResult = ref<string | null>(null)
async function sendTest() {
  testing.value = true
  testResult.value = null
  try {
    const { delivered } = await request<{ delivered: number }>('notifications/test', { method: 'POST' })
    testResult.value = delivered > 0 ? `Sent to ${delivered} webhook${delivered === 1 ? '' : 's'}.` : 'No webhook accepted the test. Check the URLs and the logs.'
  }
  catch (err) {
    testResult.value = extractError(err, 'Could not send the test.')
  }
  finally {
    testing.value = false
  }
}
</script>

<template>
  <SettingsSection
    id="notifications"
    title="Notifications"
    description="Messages to your phone or chat when a download fails for good, a friend goes offline, and a daily summary."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the notification settings." />

    <p v-else-if="pending && notifications === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else :state="state" :validate="validate" class="space-y-3" @submit="save">
      <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-highlighted">
              Webhooks
            </p>
            <p class="text-xs text-muted">
              Every notification goes to each of these. A webhook URL usually contains a secret; store it as an env var if you prefer.
            </p>
          </div>
          <UButton label="Add webhook" icon="i-ph-plus" size="sm" variant="soft" :disabled="saving" @click="() => { state.webhooks.push({ type: 'discord', url: null }) }" />
        </div>

        <p v-if="state.webhooks.length === 0" class="py-2 text-center text-xs text-muted">
          No webhooks, so nothing is sent.
        </p>

        <div v-for="(webhook, i) in state.webhooks" :key="`${seedVersion}-${i}`" class="space-y-2 rounded-md border border-default p-3">
          <div class="flex items-center justify-between gap-2">
            <USelect v-model="webhook.type" :items="typeItems" :disabled="saving" class="w-60" />
            <UButton icon="i-ph-trash" size="xs" color="error" variant="ghost" :disabled="saving" aria-label="Remove webhook" @click="() => { state.webhooks.splice(i, 1) }" />
          </div>
          <SecretInput v-model="webhook.url" :editing="true" />
        </div>
      </UCard>

      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <UFormField name="downloadFailed" label="Failed downloads" description="A download that still fails after its retries and retry window.">
          <USwitch v-model="state.downloadFailed" :disabled="saving" />
        </UFormField>
        <UFormField name="peerOffline" label="Friends going offline" description="A friend unreachable for the time below, and again when they are back.">
          <USwitch v-model="state.peerOffline" :disabled="saving" />
        </UFormField>
        <UFormField v-if="state.peerOffline" name="peerOfflineMinutes" label="Offline for at least" hint="minutes" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
          <UInputNumber v-model="state.peerOfflineMinutes" :disabled="saving" :min="5" :increment="false" :decrement="false" placeholder="60" class="w-28" />
        </UFormField>
        <UFormField name="ipBanned" label="Banned addresses">
          <template #description>
            An address banned for repeated failed authentication.
            <ULink :to="settingsLink('security')" class="underline">
              Ban settings
            </ULink>
          </template>
          <USwitch v-model="state.ipBanned" :disabled="saving" />
        </UFormField>
        <UFormField name="dailySummaryAt" label="Daily summary" description="Traffic per friend and how downloads went, once a day at this time (server time). Empty means none.">
          <UInput v-model="state.dailySummaryAt" type="time" :disabled="saving" class="w-32" />
        </UFormField>
      </UCard>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="Notification settings apply right away." />
      <UAlert v-if="testResult" color="neutral" variant="soft" icon="i-ph-paper-plane-tilt" :title="testResult" />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <UButton class="mr-auto" label="Send test" icon="i-ph-paper-plane-tilt" color="neutral" variant="soft" :loading="testing" :disabled="dirty || saving || state.webhooks.length === 0" @click="sendTest" />
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
