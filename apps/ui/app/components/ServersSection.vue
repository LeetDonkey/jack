<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
import type { ServerInput, ServerItem } from '~/types/management'

const { request, extractError } = useManagement()
const { settings, pending, error, reload } = useSettings()

const showForm = ref(false)
const editTarget = ref<ServerItem | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

const confirmTarget = ref<ServerItem | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
const confirmOpen = computed({
  get: () => confirmTarget.value !== null,
  set: (v) => {
    if (!v)
      closeConfirm()
  },
})

// Kept after the dialog closes so its text doesn't change while it animates out.
const lastConfirm = ref<ServerItem | null>(null)
watch(confirmTarget, (server) => {
  if (server)
    lastConfirm.value = server
})
const confirmArr = computed(() => arrName(lastConfirm.value?.type ?? 'radarr'))

function closeConfirm() {
  confirmTarget.value = null
  deleteError.value = null
}

function openAdd() {
  editTarget.value = null
  formError.value = null
  showForm.value = true
}
function openEdit(server: ServerItem) {
  editTarget.value = server
  formError.value = null
  showForm.value = true
}

async function submit(input: ServerInput) {
  submitting.value = true
  formError.value = null
  const arr = arrName(input.type)
  try {
    if (editTarget.value)
      await request(`config/servers/${editTarget.value.id}`, { method: 'PATCH', body: input })
    else
      await request('config/servers', { method: 'POST', body: input })
    showForm.value = false
    await reload()
  }
  catch (err) {
    formError.value = extractError(err, `Could not save this ${arr}.`)
  }
  finally {
    submitting.value = false
  }
}

async function confirmDelete() {
  if (!confirmTarget.value)
    return
  const arr = arrName(confirmTarget.value.type)
  deleting.value = true
  deleteError.value = null
  try {
    await request(`config/servers/${confirmTarget.value.id}`, { method: 'DELETE' })
    confirmTarget.value = null
    await reload()
  }
  catch (err) {
    deleteError.value = extractError(err, `Could not remove this ${arr}.`)
  }
  finally {
    deleting.value = false
  }
}

function upgradesLabel(server: ServerItem): string {
  if (!server.upgrades.allow)
    return 'only missing items from friends'
  return server.upgrades.maxSizeGiB == null ? 'upgrades from friends' : `upgrades from friends up to ${server.upgrades.maxSizeGiB} GB`
}

function statusBadge(server: ServerItem): { color: BadgeProps['color'], label: string } {
  if (server.initialized)
    return { color: 'success', label: 'Connected' }
  if (server.initializationError)
    return { color: 'error', label: 'Unreachable' }
  return { color: 'warning', label: 'Connecting' }
}

// Unreachable servers first (a broken *arr connector stops searches/imports),
// then connecting, then healthy.
function sortKey(server: ServerItem) {
  if (!server.initialized && server.initializationError)
    return 0
  if (!server.initialized)
    return 1
  return 2
}
const servers = computed(() => [...(settings.value?.servers ?? [])].sort((a, b) => sortKey(a) - sortKey(b)))
const connected = computed(() => servers.value.filter(s => s.initialized).length)
const unreachable = computed(() => servers.value.filter(s => !s.initialized && s.initializationError).length)
const sources = computed(() => servers.value.filter(s => s.source).length)
const destinations = computed(() => servers.value.filter(s => s.destination).length)
</script>

<template>
  <SettingsSection
    id="servers"
    title="Radarr & Sonarr"
    description="Each Radarr or Sonarr can share its library with friends, receive downloads from them, or both."
  >
    <template #aside>
      <UButton label="Connect Radarr or Sonarr" icon="i-ph-plus" @click="openAdd" />
    </template>

    <UAlert v-if="error && !settings" color="error" variant="soft" icon="i-ph-warning" title="Failed to load Radarr and Sonarr." />

    <p v-else-if="pending && !settings" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UCard v-else-if="settings && settings.servers.length === 0" variant="subtle">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <UIcon name="i-ph-hard-drives" class="size-8 text-dimmed" />
        <p class="text-sm text-muted">
          No Radarr or Sonarr yet. Connect one to share its library with friends or to download
          from them into it.
        </p>
        <UButton label="Connect Radarr or Sonarr" icon="i-ph-plus" @click="openAdd" />
      </div>
    </UCard>

    <div v-else-if="settings" class="space-y-3">
      <p class="text-xs tabular-nums text-muted">
        {{ connected }} of {{ servers.length }} connected<template v-if="unreachable">
          · <span class="text-error">{{ unreachable }} unreachable</span>
        </template>
        · {{ sources }} {{ sources === 1 ? 'shares' : 'share' }} with friends
        · {{ destinations }} {{ destinations === 1 ? 'receives' : 'receive' }} downloads
      </p>

      <div class="space-y-2">
        <ConnectorCard
          v-for="server in servers"
          :key="server.id"
          :name="server.name"
          :url="server.url"
          :initialized="server.initialized"
          :error="server.initializationError"
          :status="statusBadge(server)"
          @edit="openEdit(server)"
          @remove="confirmTarget = server"
        >
          <template #badge>
            <UBadge color="neutral" variant="subtle" size="sm" :label="arrName(server.type)" />
          </template>
          <template #meta>
            <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs text-muted">
              <span>{{ serverRoleLabel(server) }}</span>
              <!-- Registration and upgrades only happen for a server that receives downloads. -->
              <template v-if="server.destination">
                <span class="text-dimmed">·</span>
                <span v-if="server.autoregister.enable">auto-registers with priority {{ server.autoregister.priority }}</span>
                <span v-else>manual registration</span>
                <span class="text-dimmed">·</span>
                <span>{{ upgradesLabel(server) }}</span>
              </template>
            </div>
          </template>
        </ConnectorCard>
      </div>
    </div>
  </SettingsSection>

  <UModal v-model:open="showForm" :title="editTarget ? `Edit ${editTarget.name}` : 'Connect Radarr or Sonarr'">
    <template #body>
      <ServerForm
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
      />
    </template>
  </UModal>

  <UModal v-model:open="confirmOpen" :title="`Remove ${lastConfirm?.name}?`" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        Remove <strong>{{ lastConfirm?.name }}</strong> from jack?<template v-if="lastConfirm?.source">
          Friends no longer see its library.
        </template><template v-if="lastConfirm?.destination">
          jack stops sending downloads to it. jack's indexer and download client stay in
          {{ confirmArr }} until you delete them there.
        </template>
      </p>
      <UAlert v-if="deleteError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="deleteError" />
    </template>
    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton label="Remove" color="error" :loading="deleting" @click="confirmDelete" />
    </template>
  </UModal>
</template>
