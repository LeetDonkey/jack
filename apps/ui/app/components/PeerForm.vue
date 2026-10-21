<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { PeerInput, PeerItem, SecretRef } from '~/types/management'

const props = defineProps<{
  initial?: PeerItem | PeerInput | null
  submitting?: boolean
  // Why the last save failed (title), and the technical reason under it.
  error?: string | null
  errorDetail?: string | null
  // Set by the parent when the last save failed in a way saving with
  // `?force=true` can get past (the friend's jack didn't answer, not a bad field).
  offerForce?: boolean
  // A validation failure jack reported for one field; shown on that field.
  fieldError?: { name: string, message: string } | null
  // The primary button, when "Add friend" / "Save changes" doesn't fit.
  submitLabel?: string
  // The save updates an existing friend although `initial` is a pasted link (no id).
  updating?: boolean
}>()
// `dirty` lets the dialog refuse an outside click or Escape once something was edited.
const emit = defineEmits<{ submit: [PeerInput, boolean], cancel: [], dismissError: [], dirty: [boolean] }>()

const editing = computed(() => props.updating || Boolean(props.initial && 'id' in props.initial))

const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)
const headersEditor = useTemplateRef<{ errors: FormError[] }>('headersEditor')
const headerErrors = computed(() => headersEditor.value?.errors ?? [])

const guideUrl = docsUrl('unraid', '7-connect-to-a-friend')

const state = reactive({
  name: props.initial?.name ?? '',
  url: props.initial?.url ?? '',
  apiKey: (props.initial?.apiKey ?? null) as SecretRef | null,
  headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
})

const baseline = JSON.stringify(state)
// A header row with only a name or only a value isn't in `state`, but it is an
// edit too.
const dirty = computed(() => JSON.stringify(state) !== baseline || headerErrors.value.length > 0)
watch(dirty, isDirty => emit('dirty', isDirty), { immediate: true })

// Headers are rare, so they stay folded away unless this friend already has some
// (an edit, or a link that carried them).
const advancedOpen = ref(Object.keys(state.headers).length > 0)
const displayName = computed(() => state.name.trim() || 'your friend')

// "Add anyway" must save what was checked: an edit goes back to a normal,
// connection-checked save.
watch(state, () => {
  if (props.error && props.offerForce)
    emit('dismissError')
}, { deep: true })

// jack's own verdict on a field goes onto that field, like a check of our own,
// and stays until the field changes.
const serverErrors = useServerFieldErrors(form, name => valueAtPath(state, name))
watch(() => props.fieldError, async (fieldError) => {
  if (!fieldError) {
    serverErrors.clear()
    return
  }
  if (fieldError.name === 'headers')
    advancedOpen.value = true
  await nextTick()
  serverErrors.show([fieldError])
  void onError()
}, { immediate: true })

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.name.trim())
    errors.push({ name: 'name', message: 'Enter a name for this friend.' })
  const url = s.url.trim()
  if (!url)
    errors.push({ name: 'url', message: 'Enter their jack address.' })
  else if (!isHttpUrl(url))
    errors.push({ name: 'url', message: 'Start the address with http:// or https://, for example https://jack.example.com.' })
  if (!s.apiKey)
    errors.push({ name: 'apiKey', message: 'Paste the key your friend created for you.' })
  // A header row with only a name or only a value waits for the rest, or to be removed.
  errors.push(...headerErrors.value)
  return errors
}

// A header row's error goes as soon as the row is complete or removed.
const HEADER_ROW = /^headers\.\d+(?:\.name)?$/
watch(headerErrors, (current) => {
  const shown = form.value?.getErrors(HEADER_ROW) ?? []
  if (shown.length)
    form.value?.setErrors(current.filter(e => shown.some(s => s.name === e.name)), HEADER_ROW)
})

function input(): PeerInput {
  const peer: PeerInput = { name: state.name.trim(), url: state.url.trim(), apiKey: state.apiKey! }
  if (Object.keys(state.headers).length)
    peer.headers = state.headers
  return peer
}

function onSubmit() {
  emit('submit', input(), false)
}

// Keeps the friend even though the connection check failed; the backend holds
// the peer and retries on its own.
function saveAnyway() {
  emit('submit', input(), true)
}
</script>

<template>
  <UForm ref="form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit" @error="onError">
    <slot name="lead" />

    <UFormField name="name" label="Name" description="How they show up in your lists." required>
      <UInput v-model="state.name" :maxlength="100" placeholder="e.g. Alice" class="w-full" />
    </UFormField>
    <UFormField name="url" label="Address" description="Their public jack address, for example https://jack.example.com." required>
      <UInput v-model="state.url" placeholder="https://jack.example.com" autocomplete="off" class="w-full" />
    </UFormField>
    <UFormField name="apiKey" label="Access key" description="The key your friend created for you in their jack." required>
      <SecretInput v-model="state.apiKey" placeholder="Paste the access key" />
    </UFormField>

    <UCollapsible v-model:open="advancedOpen">
      <UButton
        variant="link"
        color="neutral"
        size="sm"
        label="Advanced"
        class="px-0"
        :icon="advancedOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
      />
      <template #content>
        <UFormField
          name="headers"
          label="Headers"
          hint="Optional"
          description="Only if their reverse proxy needs extra headers (e.g. Cloudflare Access)."
          class="pt-2"
        >
          <HeadersEditor ref="headersEditor" v-model="state.headers" />
        </UFormField>
      </template>
    </UCollapsible>

    <div v-if="error" class="space-y-1.5">
      <UAlert color="error" variant="soft" icon="i-ph-warning" :title="error">
        <template v-if="errorDetail || offerForce" #description>
          <span v-if="errorDetail" class="block font-mono text-xs break-words">{{ errorDetail }}</span>
          <span v-if="offerForce" class="mt-1 block">
            If {{ displayName }}'s jack isn't set up yet, {{ editing ? 'save' : 'add' }} anyway: jack keeps trying
            to connect in the background. Otherwise go back and check the address and key.
          </span>
        </template>
      </UAlert>
      <ULink :to="guideUrl" target="_blank" class="inline-flex items-center gap-1 text-xs text-muted underline">
        <UIcon name="i-ph-question" class="size-3.5 shrink-0" />
        Help: Connect to a friend
      </ULink>
    </div>

    <div v-if="error && offerForce" class="flex flex-wrap justify-end gap-2 pt-2">
      <UButton label="Back to edit" color="neutral" variant="ghost" :disabled="submitting" @click="emit('dismissError')" />
      <UButton
        :label="editing ? 'Save anyway, keep trying' : 'Add anyway, keep trying'"
        :loading="submitting"
        @click="saveAnyway"
      />
    </div>
    <div v-else class="flex flex-wrap items-center justify-end gap-2 pt-2">
      <p v-if="showFixHint" class="text-xs text-error">
        Fix the highlighted fields to save.
      </p>
      <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('cancel')" />
      <UButton
        type="submit"
        :loading="submitting"
        :label="submitting ? 'Saving…' : submitLabel ?? (editing ? 'Save changes' : 'Add friend')"
      />
    </div>
  </UForm>
</template>
