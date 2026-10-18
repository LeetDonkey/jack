<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { PeerInput, PeerItem, SecretRef } from '~/types/management'

const props = defineProps<{
  initial?: PeerItem | PeerInput | null
  submitting?: boolean
  error?: string | null
  // Set by the parent when the last save failed in a way saving with
  // `?force=true` can get past (the friend's jack didn't answer, not a bad field).
  offerForce?: boolean
}>()
// `dirty` lets the dialog refuse an outside click or Escape once something was edited.
const emit = defineEmits<{ submit: [PeerInput, boolean], cancel: [], dismissError: [], quickLink: [], dirty: [boolean] }>()

const editing = computed(() => Boolean(props.initial && 'id' in props.initial))

const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

const guideUrl = docsUrl('unraid', '7-connect-to-a-friend')

const state = reactive({
  name: props.initial?.name ?? '',
  url: props.initial?.url ?? '',
  apiKey: (props.initial?.apiKey ?? null) as SecretRef | null,
  headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
})

const baseline = JSON.stringify(state)
const dirty = computed(() => JSON.stringify(state) !== baseline)
watch(dirty, isDirty => emit('dirty', isDirty), { immediate: true })

// Headers are rare, so they stay folded away unless this friend already has some
// (an edit, or a quick link that carried them).
const advancedOpen = ref(Object.keys(state.headers).length > 0)
const displayName = computed(() => state.name.trim() || 'your friend')

// "Add anyway" must save what was checked: an edit goes back to a normal,
// connection-checked save.
watch(state, () => {
  if (props.error && props.offerForce)
    emit('dismissError')
}, { deep: true })

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
  return errors
}

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
    <p v-if="!initial" class="text-sm text-muted">
      Easiest: ask your friend for a quick link and use
      <UButton variant="link" size="sm" label="Add via quick link" class="p-0 align-baseline" @click="emit('quickLink')" />.
    </p>

    <UFormField name="name" label="Name" description="How they show up in your lists." required>
      <UInput v-model="state.name" placeholder="e.g. Alice" class="w-full" />
    </UFormField>
    <UFormField name="url" label="Address" description="Their public jack address, for example https://jack.example.com." required>
      <UInput v-model="state.url" placeholder="https://jack.example.com" class="w-full" />
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
          label="Headers"
          hint="Optional"
          description="Only if their reverse proxy needs extra headers (e.g. Cloudflare Access)."
          class="pt-2"
        >
          <HeadersEditor v-model="state.headers" />
        </UFormField>
      </template>
    </UCollapsible>

    <div v-if="error" class="space-y-1.5">
      <UAlert color="error" variant="soft" icon="i-ph-warning" :title="error">
        <template v-if="offerForce" #description>
          If {{ displayName }}'s jack isn't reachable yet, {{ editing ? 'save' : 'add' }} anyway: jack keeps trying
          to connect in the background. Otherwise go back and check the address and key.
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
        :label="submitting ? 'Saving…' : editing ? 'Save changes' : 'Add friend'"
      />
    </div>
  </UForm>
</template>
