<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { CreatedQuickLink, ExternalJackConfig, Friend, JackConfig, QuickLinkInput } from '~/types/management'

const props = defineProps<{
  // Prefills "Who is this link for?" (inviting from a friend's card).
  name?: string
  // The friend's peer; the new key is linked to it.
  peerId?: string | null
  // "Send a new link": the key the new link replaces.
  replaceKey?: { id: number, name: string | null } | null
  // The cards on the Friends page, to spot a friend who already has a key or a peer.
  friends?: Friend[]
}>()
// `add`: the user wants to paste this friend's link next; `keyId` is the new key,
// so the friend's peer can be linked to it.
const emit = defineEmits<{ created: [], add: [{ name: string, keyId: number }] }>()
const open = defineModel<boolean>('open', { required: true })

const { request, extractError, extractFieldError } = useManagement()

type Step = 'loading' | 'address' | 'form' | 'created'
const step = ref<Step>('loading')
const loadError = ref<string | null>(null)
const external = ref<ExternalJackConfig | null>(null)

// ── Step 1 (only when needed): the address friends use ──────────────────────
const addressForm = useTemplateRef<Form<FormSchema>>('addressForm')
const { onError: onAddressError, showFixHint: showAddressFixHint } = useFormErrorFocus(addressForm)
const address = reactive({ instanceName: '', url: '' })
const savingAddress = ref(false)
const addressError = ref<string | null>(null)
const addressGuide = docsUrl('unraid', '6-open-jack-to-your-friends')

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

function validateAddress(s: typeof address): FormError[] {
  const errors: FormError[] = []
  if (!s.instanceName.trim())
    errors.push({ name: 'instanceName', message: 'Enter the name friends see for you.' })
  const url = s.url.trim()
  if (!url)
    errors.push({ name: 'url', message: 'Enter the address friends use to reach your jack.' })
  else if (!isHttpUrl(url))
    errors.push({ name: 'url', message: 'Start the address with http:// or https://, for example https://jack.example.com.' })
  return errors
}

async function saveAddress() {
  if (savingAddress.value)
    return
  savingAddress.value = true
  addressError.value = null
  // PATCH replaces the whole profile, so headers set under Settings are sent back.
  const body: ExternalJackConfig = { instanceName: address.instanceName.trim(), url: address.url.trim() }
  if (external.value?.headers && Object.keys(external.value.headers).length)
    body.headers = external.value.headers
  try {
    await request('config/jack/external', { method: 'PATCH', body })
    external.value = body
    // Settings keeps its own copy of config.jack under this key, and Friends of
    // friends asks for the name and address until it hears they are set.
    void refreshNuxtData(['jack-config', 'introductions'])
    resetForm()
    step.value = 'form'
  }
  catch (err) {
    const field = extractFieldError(err)
    const name = field?.name.split('.').pop()
    if (field && (name === 'url' || name === 'instanceName'))
      addressForm.value?.setErrors([{ name, message: field.message }], name)
    else
      addressError.value = extractError(err, 'Could not save your address.')
  }
  finally {
    savingAddress.value = false
  }
}

// ── Step 2: who the link is for ─────────────────────────────────────────────
const linkForm = useTemplateRef<Form<FormSchema>>('linkForm')
const { onError, showFixHint } = useFormErrorFocus(linkForm)
const state = reactive({ keyName: '', peerName: '', keyDescription: '' })
const editingPeerName = ref(false)
const moreOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)
// Set by "Send a new link instead" when the name belongs to a friend with a key.
const replaceTarget = ref<{ id: number, name: string | null } | null>(null)
const replacePeerId = ref<string | null>(null)
// "This is the Alice you download from": links the key to that friend's peer.
const linkToMatch = ref(true)
let openedWith = ''
const formDirty = computed(() => step.value === 'form' && JSON.stringify(state) !== openedWith)

const friendName = computed(() => state.keyName.trim())
const replacing = computed(() => replaceTarget.value !== null)

// A card with the typed name, when the link wasn't opened from a card already.
const matchingFriend = computed(() => {
  if (props.peerId || replacing.value || !friendName.value)
    return null
  return props.friends?.find(friend => sameName(friend.name, friendName.value)) ?? null
})
const matchHasKey = computed(() => Boolean(matchingFriend.value?.keys.length))
const matchPeerOnly = computed(() => Boolean(matchingFriend.value?.peer && !matchingFriend.value.keys.length))

const effectivePeerId = computed(() => {
  if (props.peerId)
    return props.peerId
  if (replacing.value)
    return replacePeerId.value
  return matchPeerOnly.value && linkToMatch.value ? matchingFriend.value!.peer!.id : null
})

function switchToReplacement() {
  const friend = matchingFriend.value
  const key = friend ? keyToReplace(friend.keys) : null
  if (!friend || !key)
    return
  replaceTarget.value = { id: key.id, name: key.name }
  replacePeerId.value = friend.peer?.id ?? null
}

function resetForm() {
  state.keyName = props.name?.trim() ?? ''
  state.peerName = external.value?.instanceName?.trim() ?? ''
  state.keyDescription = ''
  editingPeerName.value = !state.peerName
  moreOpen.value = false
  createError.value = null
  replaceTarget.value = props.replaceKey ?? null
  replacePeerId.value = props.peerId ?? null
  linkToMatch.value = true
  openedWith = JSON.stringify(state)
}

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.keyName.trim())
    errors.push({ name: 'keyName', message: 'Enter your friend\'s name.' })
  if (!s.peerName.trim())
    errors.push({ name: 'peerName', message: 'Enter the name your friend sees.' })
  return errors
}

const generated = ref<CreatedQuickLink | null>(null)
// Step 3 state, reset by every new link.
const copied = ref(false)
const copyFailed = ref(false)
// The old key, when jack kept it: the user replaces it now or keeps both.
const replaceDecision = ref<'replaced' | 'kept' | null>(null)
const revoking = ref(false)
const revokeError = ref<string | null>(null)
// The peer the new key went to, so the next step knows whether to offer "Add".
const linkedPeerId = ref<string | null>(null)

async function create() {
  if (creating.value)
    return
  creating.value = true
  createError.value = null
  try {
    const input: QuickLinkInput = {
      peerName: state.peerName.trim(),
      keyName: friendName.value,
      keyDescription: state.keyDescription.trim() || null,
      expiresAt: null,
      peerId: effectivePeerId.value,
      replaceKeyId: replaceTarget.value?.id ?? null,
    }
    generated.value = await request<CreatedQuickLink>('quick-links', { method: 'POST', body: input })
    linkedPeerId.value = generated.value.key.peerId ?? input.peerId ?? null
    replaceDecision.value = null
    copied.value = false
    copyFailed.value = false
    revokeError.value = null
    step.value = 'created'
    emit('created')
  }
  catch (err) {
    const field = extractFieldError(err)
    if (field?.name === 'keyName' || field?.name === 'peerName')
      linkForm.value?.setErrors([field], field.name)
    else
      createError.value = extractError(err, 'Could not create the invite link.')
  }
  finally {
    creating.value = false
  }
}

// ── Step 3: the link ────────────────────────────────────────────────────────
const linkArea = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>('linkArea')

async function copyLink() {
  if (!generated.value)
    return
  copyFailed.value = false
  if (await copyTextToClipboard(generated.value.link)) {
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  }
  else {
    copyFailed.value = true
    linkArea.value?.textareaRef?.select()
  }
}

const keptOldKey = computed(() => {
  const replaced = generated.value?.replaced
  return replaced && !replaced.revoked ? replaced : null
})
const keptReason = computed(() => {
  const kept = keptOldKey.value
  if (!kept)
    return ''
  const name = friendName.value
  switch (kept.keptBecause) {
    case 'used':
      return kept.lastUsedAt ? `${name}'s jack last used it ${formatTimeAgo(kept.lastUsedAt, Date.now())}.` : `${name}'s jack has used it.`
    case 'bound':
      return `${name}'s jack uses it for friends of friends.`
    default:
      return 'jack can\'t tell whether it is still in use: the key is older than jack\'s record of key use.'
  }
})

async function replaceOldKey() {
  const kept = keptOldKey.value
  if (!kept || revoking.value)
    return
  revoking.value = true
  revokeError.value = null
  try {
    await request(`api-keys/${kept.keyId}`, { method: 'DELETE' })
    replaceDecision.value = 'replaced'
    emit('created')
  }
  catch (err) {
    revokeError.value = extractError(err, 'Could not revoke the old key.')
  }
  finally {
    revoking.value = false
  }
}

function addFriend() {
  if (!generated.value)
    return
  emit('add', { name: friendName.value, keyId: generated.value.key.id })
  open.value = false
}

// ── Opening and closing ─────────────────────────────────────────────────────
async function load() {
  step.value = 'loading'
  loadError.value = null
  generated.value = null
  addressError.value = null
  try {
    const jack = await request<JackConfig | null>('config/jack')
    external.value = jack?.external ?? null
  }
  catch (err) {
    loadError.value = extractError(err, 'Could not load your public address.')
    return
  }
  address.instanceName = external.value?.instanceName ?? ''
  address.url = external.value?.url ?? ''
  if (external.value?.url && external.value.instanceName?.trim()) {
    resetForm()
    step.value = 'form'
  }
  else {
    step.value = 'address'
  }
}

watch(open, (isOpen) => {
  if (isOpen)
    void load()
})

// The link is shown only once; it goes with the dialog, once that has animated out.
function forgetLink() {
  if (!open.value)
    generated.value = null
}

const busy = computed(() => creating.value || savingAddress.value || revoking.value)
const modalOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (!value && busy.value)
      return
    open.value = value
  },
})

const title = computed(() => {
  if (step.value === 'created')
    return `Link for ${friendName.value || 'your friend'}`
  if (step.value === 'form' && replacing.value)
    return `Send ${friendName.value || 'your friend'} a new link`
  return 'Invite a friend'
})
</script>

<template>
  <UModal
    v-model:open="modalOpen"
    :title="title"
    :dismissible="!busy && !formDirty && step !== 'created'"
    @after:leave="forgetLink"
  >
    <template #body>
      <div v-if="step === 'loading'" class="space-y-3">
        <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" :title="loadError" :actions="[{ label: 'Try again', color: 'error', variant: 'outline', onClick: load }]" />
        <p v-else class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
          Loading…
        </p>
      </div>

      <!-- The link carries your address, so it has to be set first. -->
      <UForm
        v-else-if="step === 'address'"
        ref="addressForm"
        :state="address"
        :validate="validateAddress"
        class="space-y-4"
        @submit="saveAddress"
        @error="onAddressError"
      >
        <div class="space-y-1">
          <p class="text-sm font-medium text-highlighted">
            First, set the address friends use
          </p>
          <p class="text-sm text-muted">
            The invite link tells your friend's jack where to find yours. This applies right away.
          </p>
        </div>
        <UFormField name="instanceName" label="Name friends see" description="How you show up when a friend adds you." required>
          <UInput v-model="address.instanceName" :maxlength="60" placeholder="e.g. Bob" class="w-full" />
        </UFormField>
        <UFormField name="url" label="Address friends use" required>
          <UInput v-model="address.url" placeholder="https://jack.example.com" autocomplete="off" class="w-full" />
          <template #description>
            Your jack's public address, usually through a reverse proxy.
            <ULink :to="addressGuide" target="_blank" class="underline">
              How to open jack to your friends
            </ULink>
          </template>
        </UFormField>
        <UAlert v-if="addressError" color="error" variant="soft" icon="i-ph-warning" :title="addressError" />
        <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
          <p v-if="showAddressFixHint" class="text-xs text-error">
            Fix the highlighted fields to save.
          </p>
          <UButton label="Cancel" color="neutral" variant="ghost" :disabled="savingAddress" @click="() => { open = false }" />
          <UButton type="submit" label="Save and continue" :loading="savingAddress" />
        </div>
      </UForm>

      <UForm
        v-else-if="step === 'form'"
        ref="linkForm"
        :state="state"
        :validate="validate"
        class="space-y-4"
        @submit="create"
        @error="onError"
      >
        <UFormField
          name="keyName"
          label="Who is this link for?"
          description="Their name on your Friends page, so you can limit or revoke their access later."
          required
        >
          <UInput v-model="state.keyName" :maxlength="100" placeholder="e.g. Alice" :autofocus="!state.keyName" class="w-full" />
        </UFormField>

        <p v-if="replacing" class="text-sm text-muted">
          This replaces the link you sent {{ friendName || 'them' }} before. If they never used the old one, jack revokes it now.
        </p>

        <UAlert
          v-else-if="matchHasKey"
          color="warning"
          variant="soft"
          icon="i-ph-info"
          :title="`${friendName} already has a key.`"
          description="A second link gives them a second key, and the old one keeps working."
          :actions="[{ label: 'Send a new link instead', color: 'warning', variant: 'outline', onClick: switchToReplacement }]"
        />

        <UCheckbox
          v-else-if="matchPeerOnly"
          v-model="linkToMatch"
          :label="`This is the ${matchingFriend!.name} you download from`"
          description="Shows both on one card on your Friends page."
        />

        <UFormField
          v-if="editingPeerName"
          name="peerName"
          label="Name your friend sees"
          description="Only for this link. Your friend can still change it when they add you."
          required
        >
          <UInput v-model="state.peerName" :maxlength="100" placeholder="e.g. Bob" class="w-full" />
        </UFormField>
        <p v-else class="text-sm text-muted">
          {{ friendName || 'Your friend' }} will see you as
          <span class="font-medium text-highlighted">{{ state.peerName }}</span>
          ·
          <UButton variant="link" size="sm" label="Change" class="p-0 align-baseline" @click="editingPeerName = true" />
        </p>

        <UCollapsible v-model:open="moreOpen">
          <UButton
            variant="link"
            color="neutral"
            size="sm"
            label="More options"
            class="px-0"
            :icon="moreOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
          />
          <template #content>
            <UFormField name="keyDescription" label="Key description" hint="Optional" class="pt-2">
              <UTextarea v-model="state.keyDescription" :maxlength="500" :rows="2" placeholder="A note for yourself" class="w-full" />
            </UFormField>
          </template>
        </UCollapsible>

        <UAlert v-if="createError" color="error" variant="soft" icon="i-ph-warning" :title="createError" />
        <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
          <p v-if="showFixHint" class="text-xs text-error">
            Fix the highlighted fields to continue.
          </p>
          <UButton label="Cancel" color="neutral" variant="ghost" :disabled="creating" @click="() => { open = false }" />
          <UButton type="submit" :label="replacing ? 'Create new link' : 'Create invite link'" :loading="creating" />
        </div>
      </UForm>

      <div v-else-if="step === 'created' && generated" class="space-y-4">
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-warning"
          title="Anyone with this link can search and download from your jack."
          :description="`Send it only to ${friendName || 'this friend'}, in a private message. This is the only time it's shown.`"
        />
        <UFormField label="Invite link">
          <UTextarea
            ref="linkArea"
            :model-value="generated.link"
            readonly
            :rows="5"
            class="w-full font-mono text-xs"
            @focus="(event: FocusEvent) => (event.target as HTMLTextAreaElement).select()"
          />
        </UFormField>
        <p v-if="copyFailed" class="text-xs text-warning">
          This browser doesn't let the page copy here. The link is selected: copy it with Ctrl+C (or Cmd+C).
        </p>

        <template v-if="generated.replaced">
          <p v-if="generated.replaced.revoked" class="text-sm text-muted">
            The old link no longer works.
          </p>
          <p v-else-if="replaceDecision === 'replaced'" class="text-sm text-muted">
            The old key is revoked. {{ friendName }} needs the new link to download from you.
          </p>
          <p v-else-if="replaceDecision === 'kept'" class="text-sm text-muted">
            <!-- With a peer, both keys share the friend's card; without one, each key has its own card. -->
            Both keys work. Once {{ friendName }} has pasted the new link,
            {{ linkedPeerId ? 'revoke the older key with Revoke on their card.' : 'remove the old key with Remove friend on its card.' }}
          </p>
          <UAlert
            v-else
            color="warning"
            variant="soft"
            icon="i-ph-key"
            :title="`${friendName}'s old key still works.`"
            :actions="[
              { label: 'Replace', color: 'error', variant: 'solid', loading: revoking, onClick: replaceOldKey },
              { label: 'Keep both', color: 'neutral', variant: 'outline', disabled: revoking, onClick: () => { replaceDecision = 'kept' } },
            ]"
          >
            <template #description>
              {{ keptReason }} Replace revokes it now, so {{ friendName }}'s jack can't connect until they paste the new link.
              Keep both leaves it working.
            </template>
          </UAlert>
          <UAlert v-if="revokeError" color="error" variant="soft" icon="i-ph-warning" :title="revokeError" />
        </template>

        <div v-if="!linkedPeerId" class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-elevated/50 px-3 py-2">
          <p class="min-w-0 text-sm text-muted">
            Paste {{ friendName }}'s link when they send it, so you can download from them too.
          </p>
          <UButton :label="`Add ${friendName}`" icon="i-ph-user-plus" size="sm" color="neutral" variant="outline" @click="addFriend" />
        </div>

        <div class="flex flex-wrap justify-end gap-2">
          <UButton label="Done" color="neutral" variant="ghost" :disabled="revoking" @click="() => { open = false }" />
          <UButton :label="copied ? 'Copied' : 'Copy link'" :icon="copied ? 'i-ph-check' : 'i-ph-copy'" @click="copyLink" />
        </div>
      </div>
    </template>
  </UModal>
</template>
