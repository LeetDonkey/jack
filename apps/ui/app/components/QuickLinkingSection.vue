<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { ExternalJackConfig, SecretRef } from '~/types/management'

const props = defineProps<{
  available: boolean
  initial?: ExternalJackConfig | null
  submitting?: boolean
  error?: string | null
  saved?: boolean
}>()
const emit = defineEmits<{
  submit: [ExternalJackConfig]
  generate: []
  import: []
  remove: []
}>()

const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

function initialState() {
  return {
    instanceName: props.initial?.instanceName ?? '',
    url: props.initial?.url ?? '',
    headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
  }
}

const state = reactive(initialState())
// The parent re-keys this section after a save or remove, so the saved values are
// the baseline and Save stays disabled until something differs from them.
const baseline = JSON.stringify(initialState())
const dirty = computed(() => JSON.stringify(state) !== baseline)
useUnsavedGuard().track('Quick linking', dirty)

// The confirmation belongs to the saved values; editing again retires it.
const showSaved = computed(() => props.saved && !dirty.value)

// HeadersEditor keeps its own rows, seeded once, so Revert remounts it.
const headersRevision = ref(0)
function revert() {
  Object.assign(state, initialState())
  headersRevision.value++
  form.value?.clear()
}

const guideUrl = docsUrl('unraid', '6-open-jack-to-your-friends')

// Links carry the saved name and URL, so generating needs both saved. The reason
// is shown as text under the button: a title tooltip never shows on touch screens.
const generateBlockedReason = computed(() => {
  if (!props.available)
    return 'To generate a link, save the jack section first.'
  if (!props.initial?.url || !props.initial?.instanceName)
    return 'To generate a link, fill in Instance name and External URL, then save.'
  return null
})

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.instanceName.trim())
    errors.push({ name: 'instanceName', message: 'Enter the name friends see for you.' })
  if (!s.url.trim()) {
    errors.push({ name: 'url', message: 'Enter the address friends use to reach your jack.' })
  }
  else {
    try {
      const url = new URL(s.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        errors.push({ name: 'url', message: 'Use an http:// or https:// address without a username or password in it.' })
    }
    catch {
      errors.push({ name: 'url', message: 'Enter a full address, for example https://jack.example.com.' })
    }
  }
  return errors
}

function onSubmit() {
  emit('submit', {
    instanceName: state.instanceName.trim(),
    url: state.url.trim(),
    ...(Object.keys(state.headers).length ? { headers: state.headers } : {}),
  })
}
</script>

<template>
  <SettingsSection
    id="public-address"
    title="Quick linking"
    description="How friends reach your jack. Generate a link for a friend, or add a friend from the link they sent you."
  >
    <template #aside>
      <div class="flex flex-wrap gap-2">
        <UButton
          label="Generate quick link"
          icon="i-ph-link"
          :disabled="generateBlockedReason !== null"
          @click="emit('generate')"
        />
        <UButton
          label="Add via quick link"
          color="neutral"
          variant="outline"
          icon="i-ph-link-simple"
          @click="emit('import')"
        />
      </div>
      <p v-if="generateBlockedReason" class="mt-2 text-xs text-muted">
        {{ generateBlockedReason }}
      </p>
    </template>

    <UCard v-if="!available" variant="subtle">
      <UAlert
        color="neutral"
        variant="soft"
        icon="i-ph-info"
        title="Save the jack section first"
        description="You can still add a friend from their quick link. Generating links needs the jack section saved."
      />
    </UCard>

    <UCard v-else variant="subtle" :ui="{ body: 'space-y-4' }">
      <UForm ref="form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit" @error="onError">
        <UFormField
          name="instanceName"
          label="Instance name"
          description="The name friends see for you when they add your link. They can change it on their side."
          required
        >
          <UInput v-model="state.instanceName" placeholder="e.g. Bob" :maxlength="100" class="w-full" />
        </UFormField>

        <UFormField
          name="url"
          label="External URL"
          description="Your public jack address. Friends' jacks use it to reach yours."
          required
        >
          <template #hint>
            <UButton :to="guideUrl" target="_blank" label="Help" icon="i-ph-question" color="neutral" variant="link" size="xs" class="p-0" />
          </template>
          <UInput v-model="state.url" placeholder="https://jack.example.com" class="w-full" />
        </UFormField>

        <UFormField label="Proxy headers" hint="Optional">
          <HeadersEditor :key="headersRevision" v-model="state.headers" />
          <template #help>
            <span>Only if your reverse proxy needs extra headers (e.g. Cloudflare Access). Every link you create includes them.</span>
          </template>
        </UFormField>

        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
        <UAlert v-else-if="showSaved" color="success" variant="soft" icon="i-ph-check-circle" title="Quick linking settings saved." />

        <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
          <UButton
            v-if="initial"
            type="button"
            label="Remove configuration"
            color="error"
            variant="ghost"
            class="mr-auto"
            :disabled="submitting"
            @click="emit('remove')"
          />
          <p v-if="showFixHint" class="text-xs text-error">
            Fix the highlighted fields to save.
          </p>
          <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="submitting" @click="revert" />
          <UButton type="submit" :disabled="!dirty" :loading="submitting" :label="submitting ? 'Saving…' : 'Save changes'" />
        </div>
      </UForm>
    </UCard>
  </SettingsSection>
</template>
