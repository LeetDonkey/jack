<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { NotificationsConfig, NotificationWebhook, SecretRef } from '~/types/management'

const { request, extractError } = useManagement()
const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

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

// Field label, the prompt in the empty field, and an example URL per type.
const WEBHOOK_FIELD: Record<NotificationWebhook['type'], { label: string, prompt: string, example: string }> = {
  discord: { label: 'Webhook URL', prompt: 'Paste the webhook URL', example: 'https://discord.com/api/webhooks/1234/abcd' },
  ntfy: { label: 'Topic URL', prompt: 'Paste the topic URL', example: 'https://ntfy.sh/your-topic' },
  json: { label: 'Webhook URL', prompt: 'Paste the webhook URL', example: 'http://homeassistant.local:8123/api/webhook/jack' },
}

const WEBHOOK_ERROR = /^webhooks\./

function isHttpUrl(value: string) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  }
  catch {
    return false
  }
}

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
// One key per webhook row, outside `state` so it doesn't count as an edit.
// SecretInput copies its value once, so rows keyed by index would show a removed
// row's URL in the row that moved up. New keys on every seed remount them all.
let nextRowKey = 0
const rowKeys = ref<number[]>([])

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
  rowKeys.value = state.webhooks.map(() => nextRowKey++)
}

watch(() => notifications.value, seed, { immediate: true })

function addWebhook() {
  state.webhooks.push({ type: 'discord', url: null })
  rowKeys.value.push(nextRowKey++)
}

function removeWebhook(index: number) {
  state.webhooks.splice(index, 1)
  rowKeys.value.splice(index, 1)
  // Errors are keyed by row index, which just shifted.
  if (form.value?.getErrors(WEBHOOK_ERROR).length)
    form.value.setErrors(validate(state).filter(e => e.name && WEBHOOK_ERROR.test(e.name)), WEBHOOK_ERROR)
}

const hasWebhooks = computed(() => state.webhooks.length > 0)
// Without a webhook the controls fade: nothing is sent, though they stay editable.
const controlClass = computed(() => (hasWebhooks.value ? undefined : 'opacity-60'))

// The number input stores `v ?? null`: an empty input reports undefined when it
// loses focus, which JSON leaves out, so the form would look edited.
const dirty = computed(() => JSON.stringify(state) !== baseline.value)
useUnsavedGuard().track('Notifications', dirty)

const saving = ref(false)
const { saveError, failed: saveFailed } = useSaveError()
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

function validate(s: State): FormError[] {
  const errors: FormError[] = []
  s.webhooks.forEach((w, i) => {
    const { prompt, example } = WEBHOOK_FIELD[w.type]
    if (w.url == null || w.url === '')
      errors.push({ name: `webhooks.${i}`, message: `${prompt}, for example ${example}.` })
    // jack resolves a container variable or file itself, so only a typed URL is checked.
    else if (typeof w.url === 'string' && !isHttpUrl(w.url))
      errors.push({ name: `webhooks.${i}`, message: `Start the URL with http:// or https://, for example ${example}.` })
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
    saveFailed(err, extractError(err, 'Could not save the notification settings.'))
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(notifications.value ?? null)
  form.value?.clear()
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
    <LoadErrorAlert v-if="loadError" :error="loadError" :retry="refresh" what="the notification settings" />

    <p v-else-if="pending && notifications === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else ref="form" :state="state" :validate="validate" class="space-y-3" @submit="save" @error="onError">
      <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-highlighted">
              Webhooks
            </p>
            <p class="text-xs text-muted">
              Every notification goes to each of these. A webhook URL works like a password, so you can keep it in a container variable instead.
            </p>
          </div>
          <UButton label="Add webhook" icon="i-ph-plus" size="sm" variant="soft" :disabled="saving" @click="addWebhook" />
        </div>

        <p v-if="!hasWebhooks" class="py-2 text-center text-xs text-muted">
          No webhooks, so nothing is sent.
        </p>

        <div v-for="(webhook, i) in state.webhooks" :key="rowKeys[i]" class="space-y-2 rounded-md border border-default p-3">
          <div class="flex items-center justify-between gap-2">
            <USelect v-model="webhook.type" :items="typeItems" :disabled="saving" aria-label="Webhook type" class="w-60" />
            <UButton icon="i-ph-trash" size="xs" color="error" variant="ghost" :disabled="saving" aria-label="Remove webhook" @click="removeWebhook(i)" />
          </div>
          <UFormField :name="`webhooks.${i}`" :label="WEBHOOK_FIELD[webhook.type].label">
            <SecretInput v-model="webhook.url" :placeholder="WEBHOOK_FIELD[webhook.type].prompt" />
          </UFormField>
        </div>
      </UCard>

      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <p v-if="!hasWebhooks" class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-ph-info" class="size-4 shrink-0" />
          Add a webhook above to receive these.
        </p>
        <!-- Still editable without a webhook, so the choices are ready when one is added.
             Only the controls fade: the descriptions are what tells whether a webhook
             is worth adding, and faded they fall to 2.3:1. -->
        <div class="space-y-4">
          <UFormField name="downloadFailed" label="Failed downloads" description="A download that still fails after its retries and retry window.">
            <USwitch v-model="state.downloadFailed" :disabled="saving" :class="controlClass" />
          </UFormField>
          <UFormField name="peerOffline" label="Friends going offline" description="A friend unreachable for the time below, and again when they are back.">
            <USwitch v-model="state.peerOffline" :disabled="saving" :class="controlClass" />
          </UFormField>
          <UFormField v-if="state.peerOffline" name="peerOfflineMinutes" label="Offline for at least" hint="minutes" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
            <UInputNumber :model-value="state.peerOfflineMinutes" :disabled="saving" :min="5" :increment="false" :decrement="false" placeholder="60" class="w-28" :class="controlClass" @update:model-value="v => (state.peerOfflineMinutes = v ?? null)" />
          </UFormField>
          <UFormField name="ipBanned" label="Banned addresses">
            <template #description>
              An address banned for repeated failed authentication.
              <ULink :to="settingsLink('security')" class="underline">
                Ban settings
              </ULink>
            </template>
            <USwitch v-model="state.ipBanned" :disabled="saving" :class="controlClass" />
          </UFormField>
          <UFormField name="dailySummaryAt" label="Daily summary" description="Traffic per friend and how downloads went, once a day at this time in jack's time zone. Empty means none.">
            <UInput v-model="state.dailySummaryAt" type="time" :disabled="saving" class="w-32" :class="controlClass" />
          </UFormField>
        </div>
      </UCard>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="Notification settings apply right away." />
      <UAlert v-if="testResult" color="neutral" variant="soft" icon="i-ph-paper-plane-tilt" :title="testResult" />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <UButton class="mr-auto" label="Send test" icon="i-ph-paper-plane-tilt" color="neutral" variant="soft" :loading="testing" :disabled="dirty || saving || !hasWebhooks" @click="sendTest" />
        <p v-if="showFixHint" class="text-xs text-error">
          Fix the highlighted fields to save.
        </p>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
