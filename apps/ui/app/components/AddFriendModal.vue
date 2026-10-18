<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { FriendsSnapshot, PeerInput, PeerItem } from '~/types/management'

const props = defineProps<{
  // Prefills the name for "Add without a link" (adding a friend you invited).
  name?: string
  // Update this friend instead of adding one: a new link from them, or a change of
  // address or key by hand.
  peer?: PeerItem | null
  // Where the dialog opens: the paste field (default) or the form.
  start?: 'paste' | 'form'
  // Keys this friend already downloads from you with. They are linked to the new
  // peer, so both directions show on one card.
  linkKeyIds?: number[]
}>()
const emit = defineEmits<{ saved: [], invite: [{ name: string, peerId: string }] }>()
const open = defineModel<boolean>('open', { required: true })

const { request, errorInfo, extractFieldError } = useManagement()
const toast = useToast()

type Step = 'paste' | 'review' | 'form' | 'done'
const step = ref<Step>('paste')

// ── Paste ───────────────────────────────────────────────────────────────────
const pasteForm = useTemplateRef<Form<FormSchema>>('pasteForm')
const paste = reactive({ link: '' })
// The friend the link describes; for an update, under the name they already have.
const fromLink = ref<PeerInput | null>(null)

function validatePaste(s: typeof paste): FormError[] {
  return s.link.trim() ? [] : [{ name: 'link', message: 'Paste the link your friend sent.' }]
}

function readLink() {
  const result = readQuickLink(paste.link)
  if (result.error !== undefined) {
    pasteForm.value?.setErrors([{ name: 'link', message: result.error }], 'link')
    return
  }
  fromLink.value = props.peer ? { ...result.peer, name: props.peer.name } : result.peer
  showForm('review')
}

// ── Review / form ───────────────────────────────────────────────────────────
const formRevision = ref(0)
const formDirty = ref(false)
const submitting = ref(false)
const error = ref<string | null>(null)
const errorDetail = ref<string | null>(null)
const offerForce = ref(false)
const fieldError = ref<{ name: string, message: string } | null>(null)

const formInitial = computed<PeerItem | PeerInput | null>(() => {
  if (step.value === 'review')
    return fromLink.value
  if (props.peer)
    return props.peer
  return props.name?.trim() ? { name: props.name.trim(), url: '', apiKey: '' } : null
})

function clearError() {
  error.value = null
  errorDetail.value = null
  offerForce.value = false
  fieldError.value = null
}

function showForm(next: 'review' | 'form') {
  clearError()
  formDirty.value = false
  formRevision.value++
  step.value = next
}

function showPaste() {
  clearError()
  formDirty.value = false
  paste.link = ''
  step.value = 'paste'
}

// The fields PeerForm shows; jack names a header as `headers.<name>`.
const PEER_FIELDS = new Set(['name', 'url', 'apiKey', 'headers'])
const TRAILING_SLASHES = /\/+$/

function sameUrl(a: string, b: string): boolean {
  return a.trim().replace(TRAILING_SLASHES, '').toLowerCase() === b.trim().replace(TRAILING_SLASHES, '').toLowerCase()
}

async function save(input: PeerInput, force: boolean) {
  if (submitting.value)
    return
  submitting.value = true
  clearError()
  // force: keep the friend even if their jack doesn't answer; jack keeps trying.
  const query = force ? { force: 'true' } : undefined
  try {
    if (props.peer)
      await request(`config/peers/${props.peer.id}`, { method: 'PATCH', body: input, query })
    else
      await request('config/peers', { method: 'POST', body: input, query })
  }
  catch (err) {
    const field = extractFieldError(err)
    const name = field?.name.split('.')[0]
    if (field && name && PEER_FIELDS.has(name)) {
      fieldError.value = { name, message: field.message }
    }
    else {
      const problem = describePeerSaveError(errorInfo(err), input.name, props.peer ? 'Could not save this friend.' : 'Could not add this friend.')
      error.value = problem.title
      errorDetail.value = problem.detail
      offerForce.value = !force && problem.offerForce
    }
    submitting.value = false
    return
  }
  try {
    await afterSave(input, force)
  }
  finally {
    submitting.value = false
    emit('saved')
  }
}

// Who was just saved, for "Invite <name>".
// `forced`: saved with Add anyway, so their jack may not have answered yet.
const saved = ref<{ name: string, peerId: string, forced: boolean } | null>(null)

async function afterSave(input: PeerInput, forced: boolean) {
  // POST answers without the new peer's id (it comes from the address), so it is
  // looked up on the Friends snapshot.
  let snapshot: FriendsSnapshot | null = null
  try {
    snapshot = await request<FriendsSnapshot>('friends')
  }
  catch {
    // Only the follow-up steps need it.
  }
  const peer = snapshot?.peers.find(p => sameUrl(p.url, input.url)) ?? snapshot?.peers.find(p => sameName(p.name, input.name)) ?? null

  const keyIds = props.linkKeyIds ?? []
  if (peer && keyIds.length) {
    const results = await Promise.allSettled(keyIds.map(id => request(`api-keys/${id}`, { method: 'PATCH', body: { peerId: peer.id } })))
    if (results.some(r => r.status === 'rejected'))
      toast.add({ color: 'warning', icon: 'i-ph-warning', title: `Added ${input.name}, but couldn't show both directions on one card.`, description: 'Use Link on the Friends page to put them together.' })
  }

  const card = peer ? snapshot?.friends.find(friend => friend.peer?.id === peer.id) : undefined
  if (!props.peer && peer && !keyIds.length && card && card.keys.length === 0) {
    saved.value = { name: peer.name, peerId: peer.id, forced }
    step.value = 'done'
    return
  }
  toast.add({
    color: 'success',
    icon: 'i-ph-check-circle',
    title: props.peer ? `Saved ${input.name}.` : `Added ${input.name}.`,
    description: forced ? `jack keeps trying to reach ${input.name}'s jack.` : undefined,
  })
  open.value = false
}

function invite() {
  if (!saved.value)
    return
  emit('invite', { name: saved.value.name, peerId: saved.value.peerId })
  open.value = false
}

// ── Opening and closing ─────────────────────────────────────────────────────
watch(open, (isOpen) => {
  if (!isOpen)
    return
  saved.value = null
  fromLink.value = null
  paste.link = ''
  if (props.start === 'form')
    showForm('form')
  else
    showPaste()
})

const modalOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (!value && submitting.value)
      return
    open.value = value
  },
})

// A pasted link or an edit keeps the dialog open on an outside click or Escape.
const dismissible = computed(() => !submitting.value && !formDirty.value && step.value !== 'review' && !(step.value === 'paste' && paste.link.trim()))

const peerName = computed(() => props.peer?.name ?? '')
const title = computed(() => {
  switch (step.value) {
    case 'paste':
      return props.peer ? `New link from ${peerName.value}` : 'Add a friend'
    case 'review':
      return props.peer ? `Update ${peerName.value}` : `Add ${fromLink.value?.name || 'friend'}`
    case 'form':
      return props.peer ? `Change ${peerName.value}'s address or key` : 'Add a friend'
    default:
      return `Added ${saved.value?.name ?? 'your friend'}`
  }
})
</script>

<template>
  <UModal v-model:open="modalOpen" :title="title" :dismissible="dismissible">
    <template #body>
      <UForm
        v-if="step === 'paste'"
        ref="pasteForm"
        :state="paste"
        :validate="validatePaste"
        class="space-y-4"
        @submit="readLink"
      >
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-shield-warning"
          title="A link contains a key to your friend's jack."
          description="Only use a link your friend sent you directly. You can check everything before it is saved."
        />
        <UFormField name="link" label="Paste the link your friend sent" required>
          <UTextarea v-model="paste.link" :rows="5" autocomplete="off" autofocus placeholder="jack-link:v1:…" class="w-full font-mono text-xs" />
        </UFormField>
        <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
          <UButton
            :label="peer ? 'Change address or key by hand' : 'Add without a link'"
            color="neutral"
            variant="link"
            class="mr-auto px-0"
            @click="showForm('form')"
          />
          <UButton label="Cancel" color="neutral" variant="ghost" @click="() => { open = false }" />
          <UButton type="submit" label="Continue" trailing-icon="i-ph-arrow-right" />
        </div>
      </UForm>

      <PeerForm
        v-else-if="step === 'review' || step === 'form'"
        :key="formRevision"
        :initial="formInitial"
        :submitting="submitting"
        :error="error"
        :error-detail="errorDetail"
        :offer-force="offerForce"
        :field-error="fieldError"
        :updating="Boolean(peer)"
        @submit="save"
        @cancel="() => { open = false }"
        @dismiss-error="clearError"
        @dirty="(isDirty) => { formDirty = isDirty }"
      >
        <template #lead>
          <p v-if="step === 'review' && peer" class="text-sm text-muted">
            jack uses the address and key from this link for {{ peer.name }} from now on.
          </p>
          <p v-else-if="step === 'review'" class="text-sm text-muted">
            Check what the link says. You can change the name; the rest comes from your friend's jack.
          </p>
          <p v-else-if="peer" class="text-sm text-muted">
            Got a new link from {{ peer.name }}?
            <UButton variant="link" size="sm" label="Paste it instead" class="p-0 align-baseline" @click="showPaste" />
          </p>
          <p v-else class="text-sm text-muted">
            Have a link from your friend?
            <UButton variant="link" size="sm" label="Paste it instead" class="p-0 align-baseline" @click="showPaste" />
          </p>
        </template>
      </PeerForm>

      <div v-else-if="step === 'done' && saved" class="space-y-4">
        <p v-if="saved.forced" class="flex items-start gap-2 text-sm text-default">
          <UIcon name="i-ph-clock" class="mt-0.5 size-4 shrink-0 text-warning" />
          jack keeps trying to reach {{ saved.name }}'s jack. You can download from {{ saved.name }} once it answers.
        </p>
        <p v-else class="flex items-start gap-2 text-sm text-default">
          <UIcon name="i-ph-check-circle" class="mt-0.5 size-4 shrink-0 text-success" />
          You can download from {{ saved.name }} now.
        </p>
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-elevated/50 px-3 py-2">
          <p class="min-w-0 text-sm text-muted">
            {{ saved.name }} can download from you once you send them a link.
          </p>
          <UButton :label="`Invite ${saved.name}`" icon="i-ph-link" size="sm" @click="invite" />
        </div>
        <div class="flex justify-end">
          <UButton label="Done" color="neutral" variant="ghost" @click="() => { open = false }" />
        </div>
      </div>
    </template>
  </UModal>
</template>
