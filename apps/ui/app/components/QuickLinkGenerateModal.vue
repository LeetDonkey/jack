<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { ApiKey, CreatedQuickLink, QuickLinkInput } from '~/types/management'

const props = defineProps<{ instanceName: string }>()
const emit = defineEmits<{ generated: [] }>()
const open = defineModel<boolean>('open', { required: true })
const { request, extractError } = useManagement()

const generated = ref<CreatedQuickLink | null>(null)
const generating = ref(false)
const copied = ref(false)
const error = ref<string | null>(null)
// keyName is the friend's name: it names the API key the link carries, which is
// how that friend shows up on the Friends page and in per-friend limits.
const state = reactive({ keyName: '', peerName: '', keyDescription: '' })
// The name the friend sees (peerName) defaults to ours and is tucked behind
// "Change"; the field shows up front only when there is no default.
const editingPeerName = ref(false)
const moreOpen = ref(false)
const existingKeys = ref<ApiKey[]>([])
const modalOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (!value && generating.value)
      return
    open.value = value
  },
})

const friendName = computed(() => state.keyName.trim())
// Best effort: a second link for the same friend is fine, but the old key keeps
// working until it is revoked, so say so.
const duplicateKey = computed(() => {
  const name = friendName.value.toLowerCase()
  return name !== '' && existingKeys.value.some(key => key.name?.trim().toLowerCase() === name)
})

async function loadExistingKeys() {
  try {
    existingKeys.value = await request<ApiKey[]>('api-keys')
  }
  catch {
    existingKeys.value = []
  }
}

function reset() {
  generated.value = null
  generating.value = false
  copied.value = false
  error.value = null
  state.keyName = ''
  state.peerName = props.instanceName
  state.keyDescription = ''
  editingPeerName.value = !props.instanceName.trim()
  moreOpen.value = false
}

watch(open, (isOpen) => {
  if (isOpen) {
    reset()
    void loadExistingKeys()
  }
  else {
    generated.value = null
  }
})

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.keyName.trim())
    errors.push({ name: 'keyName', message: 'Enter your friend\'s name.' })
  if (!s.peerName.trim())
    errors.push({ name: 'peerName', message: 'Enter the name your friend sees.' })
  return errors
}

async function generate() {
  if (generating.value)
    return
  generating.value = true
  error.value = null
  try {
    const input: QuickLinkInput = {
      peerName: state.peerName.trim(),
      keyName: state.keyName.trim(),
      keyDescription: state.keyDescription.trim() || null,
      expiresAt: null,
    }
    generated.value = await request<CreatedQuickLink>('quick-links', { method: 'POST', body: input })
    emit('generated')
  }
  catch (err) {
    error.value = extractError(err, 'Could not generate the quick link.')
  }
  finally {
    generating.value = false
  }
}

async function copyLink() {
  if (!generated.value)
    return
  try {
    await navigator.clipboard.writeText(generated.value.link)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  }
  catch {
    error.value = 'Could not copy the quick link. Select and copy it manually.'
  }
}

function close() {
  if (generating.value)
    return
  generated.value = null
  open.value = false
}
</script>

<template>
  <UModal v-model:open="modalOpen" title="Generate quick link" :dismissible="!generating" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-warning"
          title="Anyone with this link can search and download from your jack."
          description="Send it only to this friend, in a private message."
        />

        <UForm v-if="!generated" :state="state" :validate="validate" class="space-y-4" @submit="generate">
          <UFormField
            name="keyName"
            label="Who is this link for?"
            description="Their name on your Friends page, so you can limit or revoke their access later."
            required
          >
            <UInput v-model="state.keyName" :maxlength="100" placeholder="e.g. Alice" autofocus class="w-full" />
          </UFormField>

          <UAlert
            v-if="duplicateKey"
            color="warning"
            variant="soft"
            icon="i-ph-info"
            :title="`${friendName} already has a key. Revoke the old one under Friend access keys after they paste the new link.`"
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

          <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
          <div class="flex justify-end gap-2 pt-2">
            <UButton label="Cancel" color="neutral" variant="ghost" :disabled="generating" @click="close" />
            <UButton type="submit" label="Generate link" :loading="generating" />
          </div>
        </UForm>

        <template v-else>
          <UFormField
            label="Quick link"
            :description="`Send this to ${generated.key.name ?? 'your friend'}. It is shown only here, so copy it before you close this dialog.`"
          >
            <UTextarea :model-value="generated.link" readonly :rows="6" class="w-full font-mono text-xs" />
          </UFormField>
          <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
          <div class="flex justify-end gap-2">
            <UButton label="Close" color="neutral" variant="ghost" @click="close" />
            <UButton :label="copied ? 'Copied' : 'Copy quick link'" :icon="copied ? 'i-ph-check' : 'i-ph-copy'" @click="copyLink" />
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
