<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
import type { PeerInput, PeerItem } from '~/types/management'

const { request, extractError } = useManagement()
const { settings, pending, error, reload } = useSettings()

const showForm = ref(false)
const editTarget = ref<PeerItem | null>(null)
const importedInput = ref<PeerInput | null>(null)
const formRevision = ref(0)
const formInitial = computed(() => editTarget.value ?? importedInput.value)
const submitting = ref(false)
const formError = ref<string | null>(null)
// Whether the last failure was one a forced save can get past (see submit).
const formOfferForce = ref(false)
// An edited form keeps the dialog open on an outside click or Escape.
const formDirty = ref(false)
const showImport = ref(false)
watch(showForm, (isOpen) => {
  if (!isOpen) {
    importedInput.value = null
    formDirty.value = false
    clearFormError()
  }
})

const confirmTarget = ref<PeerItem | null>(null)
// Kept after the dialog closes so the title doesn't change while it animates out.
const confirmName = ref('')
watch(confirmTarget, (peer) => {
  if (peer)
    confirmName.value = peer.name
})
const deleting = ref(false)
const deleteError = ref<string | null>(null)
const confirmOpen = computed({
  get: () => confirmTarget.value !== null,
  set: (v) => {
    if (!v)
      closeConfirm()
  },
})

// Surface trouble first: unreachable peers sort to the top, then connecting,
// then healthy — so the ones you might need to fix are never buried.
function sortKey(peer: PeerItem) {
  if (!peer.initialized && peer.initializationError)
    return 0
  if (!peer.initialized)
    return 1
  return 2
}
const peers = computed(() => [...(settings.value?.peers ?? [])].sort((a, b) => sortKey(a) - sortKey(b)))
const peerTextClass = (id: string) => settings.value?.peerColors.get(id)?.text ?? peerColorTextClass(id)
const connected = computed(() => peers.value.filter(p => p.initialized).length)
const unreachable = computed(() => peers.value.filter(p => !p.initialized && p.initializationError).length)

function statusBadge(peer: PeerItem): { color: BadgeProps['color'], label: string } {
  if (peer.initialized)
    return { color: 'success', label: 'Connected' }
  if (peer.initializationError)
    return { color: 'error', label: 'Unreachable' }
  return { color: 'warning', label: 'Connecting' }
}

function closeConfirm() {
  confirmTarget.value = null
  deleteError.value = null
}

function clearFormError() {
  formError.value = null
  formOfferForce.value = false
}

function openAdd() {
  editTarget.value = null
  importedInput.value = null
  clearFormError()
  formRevision.value++
  showForm.value = true
}
function openEdit(peer: PeerItem) {
  editTarget.value = peer
  importedInput.value = null
  clearFormError()
  formRevision.value++
  showForm.value = true
}
function reviewImported(peer: PeerInput) {
  editTarget.value = null
  importedInput.value = peer
  clearFormError()
  formRevision.value++
  showForm.value = true
}
defineExpose({ reviewImported })
function closeForm() {
  showForm.value = false
  importedInput.value = null
}
// The blank form points to quick links; swap it for the paste dialog.
function switchToQuickLink() {
  closeForm()
  showImport.value = true
}

function errorStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }, statusCode?: number }
  return e?.response?.status ?? e?.statusCode
}

async function submit(input: PeerInput, force = false) {
  submitting.value = true
  clearFormError()
  // force: persist the peer even if its handshake fails — the backend keeps it
  // resident and retries lazily instead of rejecting the add.
  const query = force ? { force: 'true' } : undefined
  try {
    if (editTarget.value)
      await request(`config/peers/${editTarget.value.id}`, { method: 'PATCH', body: input, query })
    else
      await request('config/peers', { method: 'POST', body: input, query })
    closeForm()
    await reload()
  }
  catch (err) {
    formError.value = extractError(err, 'Could not save this friend.')
    // A failed handshake is a 502, and the BFF answers 5xx when jack itself
    // didn't respond. 4xx means the request itself is wrong (bad field, a
    // duplicate name or address, a peer that no longer exists), which forcing
    // can't fix.
    const status = errorStatus(err)
    formOfferForce.value = !force && (status === undefined || status >= 500)
  }
  finally {
    submitting.value = false
  }
}

async function confirmDelete() {
  if (!confirmTarget.value)
    return
  deleting.value = true
  deleteError.value = null
  try {
    await request(`config/peers/${confirmTarget.value.id}`, { method: 'DELETE' })
    confirmTarget.value = null
    await reload()
  }
  catch (err) {
    deleteError.value = extractError(err, 'Could not remove this friend.')
  }
  finally {
    deleting.value = false
  }
}
</script>

<template>
  <SettingsSection id="peers" title="Friends you download from" description="Friends whose libraries you can download from.">
    <template #aside>
      <UButton label="Add a friend" icon="i-ph-plus" @click="openAdd" />
    </template>

    <UAlert v-if="error && !settings" color="error" variant="soft" icon="i-ph-warning" title="Failed to load your friends." />

    <p v-else-if="pending && !settings" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UCard v-else-if="settings && settings.peers.length === 0" variant="subtle">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <UIcon name="i-ph-users-three" class="size-8 text-dimmed" />
        <p class="text-sm text-muted">
          No friends yet. Add a friend to download from their library.
        </p>
        <UButton label="Add a friend" icon="i-ph-plus" @click="openAdd" />
      </div>
    </UCard>

    <div v-else-if="settings" class="space-y-3">
      <p class="text-xs tabular-nums text-muted">
        {{ connected }} of {{ peers.length }} connected<template v-if="unreachable">
          · <span class="text-error">{{ unreachable }} unreachable</span>
        </template>
      </p>

      <div class="space-y-2">
        <ConnectorCard
          v-for="peer in peers"
          :key="peer.id"
          :name="peer.name"
          :accent-class="peerTextClass(peer.id)"
          :url="peer.url"
          :initialized="peer.initialized"
          :error="peer.initializationError"
          :status="statusBadge(peer)"
          @edit="openEdit(peer)"
          @remove="confirmTarget = peer"
        >
          <template v-if="peer.version" #badge>
            <UBadge color="neutral" variant="subtle" size="sm" :label="`v${peer.version}`" />
          </template>
        </ConnectorCard>
      </div>
    </div>
  </SettingsSection>

  <UModal v-model:open="showForm" :title="editTarget ? `Edit ${editTarget.name}` : 'Add a friend'" :dismissible="!formDirty">
    <template #body>
      <PeerForm
        :key="formRevision"
        :initial="formInitial"
        :submitting="submitting"
        :error="formError"
        :offer-force="formOfferForce"
        @submit="submit"
        @cancel="closeForm"
        @dismiss-error="clearFormError"
        @quick-link="switchToQuickLink"
        @dirty="(isDirty) => { formDirty = isDirty }"
      />
    </template>
  </UModal>

  <QuickLinkImportModal v-model:open="showImport" @imported="reviewImported" />

  <UModal v-model:open="confirmOpen" :title="`Stop downloading from ${confirmName}?`" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        Searches stop using their library right away; downloads in progress finish.
        <strong>{{ confirmName }}</strong> can still download from you until you revoke their key under
        <UButton :to="settingsLink('access-keys')" variant="link" label="Friend access keys" class="p-0 align-baseline" @click="closeConfirm" />.
      </p>
      <UAlert v-if="deleteError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="deleteError" />
    </template>
    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton label="Stop downloading" color="error" :loading="deleting" @click="confirmDelete" />
    </template>
  </UModal>
</template>
