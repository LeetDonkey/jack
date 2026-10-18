<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { ExternalJackConfig, SecretRef } from '~/types/management'
import type { ValidationErrorBody } from '~/types/settings'

// Settings > Sharing > Your public address: jack.external, which invite links and
// friends of friends carry. Inviting and adding friends happens on /friends.
const { request, extractError } = useManagement()
const { data: jack, pending, error: loadError, refresh } = useJackConfig()

const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

// The name for friends of friends (discovery.publicName) falls back to this one
// and allows 60 characters, so this stays within that.
const NAME_MAX = 60

function stateFrom(external: ExternalJackConfig | null | undefined) {
  return {
    instanceName: external?.instanceName ?? '',
    url: external?.url ?? '',
    headers: { ...(external?.headers ?? {}) } as Record<string, SecretRef>,
  }
}

const state = reactive(stateFrom(null))
const baseline = ref(JSON.stringify(state))
// HeadersEditor keeps its own rows, seeded once, so a new baseline remounts it.
const headersRevision = ref(0)

function seed(external: ExternalJackConfig | null | undefined) {
  Object.assign(state, stateFrom(external))
  baseline.value = JSON.stringify(state)
  headersRevision.value++
  form.value?.clear()
}

const dirty = computed(() => JSON.stringify(state) !== baseline.value)
useUnsavedGuard().track('Your public address', dirty)

// The first load seeds the form. A later read never overwrites edits in progress.
watch(jack, (config) => {
  if (!dirty.value)
    seed(config?.external)
}, { immediate: true })

const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
// The confirmation belongs to the saved values; editing again retires it.
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

const guideUrl = docsUrl('unraid', '6-open-jack-to-your-friends')

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  const name = s.instanceName.trim()
  if (!name)
    errors.push({ name: 'instanceName', message: 'Enter the name friends see for you.' })
  else if (name.length > NAME_MAX)
    errors.push({ name: 'instanceName', message: `Use at most ${NAME_MAX} characters.` })
  if (!s.url.trim()) {
    errors.push({ name: 'url', message: 'Enter the address friends use to reach your jack.' })
  }
  else {
    try {
      const url = new URL(s.url.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        errors.push({ name: 'url', message: 'Use an http:// or https:// address without a username or password in it.' })
    }
    catch {
      errors.push({ name: 'url', message: 'Enter a full address, for example https://jack.example.com.' })
    }
  }
  return errors
}

// A 400 that names one of this form's fields is shown on that field.
const FORM_FIELDS = new Set(['instanceName', 'url'])
function fieldErrors(err: unknown): FormError[] {
  const body = (err as { data?: Partial<ValidationErrorBody> } | null)?.data
  if (body?.error?.code !== 'VALIDATION_ERROR')
    return []
  const issues = body.error.issues?.length
    ? body.error.issues
    : [{ field: body.error.field, message: body.error.message }]
  return issues.flatMap(issue => issue.field && FORM_FIELDS.has(issue.field) ? [{ name: issue.field, message: issue.message }] : [])
}

async function onSubmit() {
  saving.value = true
  saveError.value = null
  saved.value = false
  const external: ExternalJackConfig = {
    instanceName: state.instanceName.trim(),
    url: state.url.trim(),
    ...(Object.keys(state.headers).length ? { headers: state.headers } : {}),
  }
  try {
    // Replaces the whole block: headers left out here are removed.
    await request('config/jack/external', { method: 'PATCH', body: external })
    // What jack stored is the new baseline, even if the read-back below fails.
    seed(external)
    saved.value = true
    await refresh()
  }
  catch (err) {
    const errors = fieldErrors(err)
    if (errors.length) {
      form.value?.setErrors(errors)
      void onError()
    }
    else {
      saveError.value = extractError(err, 'Could not save your public address.')
    }
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(jack.value?.external)
  saveError.value = null
  saved.value = false
}

const hasSaved = computed(() => Boolean(jack.value?.external))
const showRemove = ref(false)
const removing = ref(false)
const removeError = ref<string | null>(null)
watch(showRemove, (open) => {
  if (open)
    removeError.value = null
})

async function remove() {
  removing.value = true
  removeError.value = null
  try {
    await request('config/jack/external', { method: 'DELETE' })
    seed(null)
    saveError.value = null
    saved.value = false
    showRemove.value = false
    await refresh()
  }
  catch (err) {
    removeError.value = extractError(err, 'Could not remove your public address.')
  }
  finally {
    removing.value = false
  }
}
</script>

<template>
  <SettingsSection
    id="public-address"
    title="Your public address"
    description="How friends' jacks reach yours. Invite links and friends of friends use it."
  >
    <template #aside>
      <p class="text-xs text-muted">
        Invite friends from the
        <ULink to="/friends" class="underline">
          Friends page
        </ULink>.
      </p>
    </template>

    <UAlert v-if="loadError && jack === undefined" color="error" variant="soft" icon="i-ph-warning" title="Failed to load your public address." />

    <p v-else-if="pending && jack === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <!-- A config file without a jack block. Saving the address Radarr/Sonarr use
         creates it, and jack refuses a public address until then. -->
    <UCard v-else-if="jack === null" variant="subtle">
      <UAlert
        color="neutral"
        variant="soft"
        icon="i-ph-info"
        title="Save the address Radarr/Sonarr use to reach jack first"
        :actions="[{ label: 'Open Radarr & Sonarr', to: settingsLink('internal-url'), color: 'neutral', variant: 'outline', size: 'sm' }]"
      />
    </UCard>

    <UCard v-else variant="subtle" :ui="{ body: 'space-y-4' }">
      <UForm ref="form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit" @error="onError">
        <UFormField
          name="instanceName"
          label="Name friends see"
          description="How you show up when a friend adds you. Friends of friends see it too, unless you choose another name for them below."
          required
        >
          <UInput v-model="state.instanceName" :disabled="saving" placeholder="e.g. Bob" :maxlength="NAME_MAX" class="w-full" />
        </UFormField>

        <UFormField
          name="url"
          label="Address friends use"
          description="Your jack's public address, usually through a reverse proxy."
          required
        >
          <template #hint>
            <UButton :to="guideUrl" target="_blank" label="Help" icon="i-ph-question" color="neutral" variant="link" size="xs" class="p-0" />
          </template>
          <div class="space-y-2">
            <UInput v-model="state.url" :disabled="saving" placeholder="https://jack.example.com" class="w-full" />
            <!-- Checks what is typed, so an address can be tried before saving. -->
            <ExternalUrlCheck :url="state.url.trim()" :headers="state.headers" />
          </div>
        </UFormField>

        <UFormField label="Proxy headers (optional)">
          <HeadersEditor :key="headersRevision" v-model="state.headers" />
          <template #help>
            <span>Only if your reverse proxy needs extra headers (e.g. Cloudflare Access). Every invite link you create includes them.</span>
          </template>
        </UFormField>

        <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
        <UAlert
          v-else-if="saved && !dirty"
          color="success"
          variant="soft"
          icon="i-ph-check-circle"
          title="Saved."
          description="Invite links you create from now on use this."
        />

        <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
          <UButton
            v-if="hasSaved"
            type="button"
            label="Remove"
            color="error"
            variant="ghost"
            class="mr-auto"
            :disabled="saving"
            @click="() => { showRemove = true }"
          />
          <p v-if="showFixHint" class="text-xs text-error">
            Fix the highlighted fields to save.
          </p>
          <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
          <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
        </div>
      </UForm>
    </UCard>

    <UModal v-model:open="showRemove" title="Remove your public address?" :ui="{ footer: 'justify-end' }">
      <template #body>
        <p class="text-sm text-default">
          jack forgets the name friends see, the address friends use and the proxy headers.
          Friends who already have one of your links keep their access. Until you set an address again,
          you can't create invite links or connect with friends of friends.
        </p>
        <UAlert v-if="removeError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="removeError" />
      </template>
      <template #footer="{ close }">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
        <UButton label="Remove" color="error" :loading="removing" @click="remove" />
      </template>
    </UModal>
  </SettingsSection>
</template>
