<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
import type { DestinationRegistration, ServerInput, ServerItem, ServerSaveResponse } from '~/types/management'
import type { RegistrationTone } from '~/utils/server-role'

const { request, extractError } = useManagement()
const { settings, pending, error, reload, applyServerRegistration } = useSettings()
const toast = useToast()

const showForm = ref(false)
const editTarget = ref<ServerItem | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)
// Set by ServerForm once a field differs from what the dialog opened with.
const formDirty = ref(false)
// What the last save set up in the server, shown in the dialog in place of the
// form until Done.
const saved = ref<{ name: string, registration: DestinationRegistration | null, pending: boolean } | null>(null)
// An outside click or Escape must not throw away edits or hide a save in progress.
const formDismissible = computed(() => saved.value !== null || !(formDirty.value || submitting.value))
const formTitle = computed(() => {
  if (saved.value)
    return saved.value.name
  return editTarget.value ? `Edit ${editTarget.value.name}` : 'Connect Radarr or Sonarr'
})
watch(showForm, (open) => {
  if (!open)
    formDirty.value = false
})
useUnsavedGuard().track('Radarr & Sonarr', computed(() => showForm.value && formDirty.value && !saved.value))

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

// "3 min ago" and the 10-minute "never" have to move on their own; they read the
// clock, which Vue doesn't track.
const now = ref(Date.now())
const clockTimer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
  clockTimer.value = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => clearInterval(clockTimer.value))

function closeConfirm() {
  confirmTarget.value = null
  deleteError.value = null
}

function openForm(server: ServerItem | null) {
  editTarget.value = server
  formError.value = null
  formDirty.value = false
  saved.value = null
  showForm.value = true
}

// A registration that outlived the request's wait (about 25 s) arrives on the
// stream. Until a result newer than `previousAt` shows up, the card says it's
// still testing, for two minutes at most.
const PENDING_MAX_MS = 2 * 60_000
const pendingRegistrations = reactive(new Map<string, { previousAt: string | null, since: number }>())
function markPending(id: string, previousAt: string | null) {
  pendingRegistrations.set(id, { previousAt, since: Date.now() })
}
function isTesting(server: ServerItem): boolean {
  const waiting = pendingRegistrations.get(server.id)
  return Boolean(waiting && (server.registration?.at ?? null) === waiting.previousAt && now.value - waiting.since < PENDING_MAX_MS)
}

async function submit(input: ServerInput) {
  submitting.value = true
  formError.value = null
  const arr = arrName(input.type)
  const target = editTarget.value
  const previousAt = target ? (settings.value?.servers.find(s => s.id === target.id)?.registration?.at ?? null) : null
  try {
    const res = target
      ? await request<ServerSaveResponse>(`config/servers/${target.id}`, { method: 'PATCH', body: input })
      : await request<ServerSaveResponse>('config/servers', { method: 'POST', body: input })
    // A server jack doesn't add itself to has nothing to report.
    if (res.registration || res.registrationPending)
      saved.value = { name: input.name, registration: res.registration, pending: res.registrationPending }
    else
      showForm.value = false
    await reload()
    if (res.registrationPending) {
      const id = target?.id ?? settings.value?.servers.find(s => s.name === input.name)?.id
      if (id)
        markPending(id, previousAt)
    }
  }
  catch (err) {
    formError.value = extractError(err, `Could not save this ${arr}.`)
  }
  finally {
    submitting.value = false
  }
}

const registering = reactive(new Set<string>())
// A failed Register again stays on the card until the server's registration
// changes, for example when jack reaches a server that was down and registers there.
const registerErrors = reactive(new Map<string, { message: string, previousAt: string | null }>())
function registerError(server: ServerItem): string | null {
  const failed = registerErrors.get(server.id)
  return failed && (server.registration?.at ?? null) === failed.previousAt ? failed.message : null
}

async function registerAgain(server: ServerItem) {
  if (registering.has(server.id))
    return
  registering.add(server.id)
  registerErrors.delete(server.id)
  const previousAt = server.registration?.at ?? null
  try {
    const res = await request<ServerSaveResponse>(`config/servers/${server.id}/register`, { method: 'POST' })
    if (res.registration) {
      applyServerRegistration(server.id, res.registration)
      // Worded as the result dialog after a save words the same outcome.
      const { tone } = registrationSummary(res.registration)
      toast.add({
        color: tone === 'ok' ? 'success' : tone,
        icon: tone === 'ok' ? 'i-ph-check-circle' : 'i-ph-warning',
        title: tone === 'ok'
          ? `jack is set up in ${server.name}.`
          : res.registration.message ?? `jack couldn't finish setting itself up in ${server.name}.`,
      })
    }
    else if (res.registrationPending) {
      markPending(server.id, previousAt)
    }
  }
  catch (err) {
    registerErrors.set(server.id, { message: extractError(err, `Could not register jack in ${server.name} again.`), previousAt })
  }
  finally {
    registering.delete(server.id)
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

const TONE_CLASS: Record<RegistrationTone, string> = { ok: 'text-success', warning: 'text-warning', error: 'text-error' }

// What jack set up in a server it adds itself to, and whether that server has
// used it since.
function registrationView(server: ServerItem) {
  const registration = server.registration
  const summary = registration ? registrationSummary(registration) : null
  return {
    testing: isTesting(server),
    parts: summary?.parts ?? null,
    message: registration?.message ?? null,
    messageClass: summary && summary.tone !== 'ok' ? TONE_CLASS[summary.tone] : 'text-muted',
    fix: registration ? registrationFix(registration) : null,
    contact: arrContact(server, now.value),
    registerError: registerError(server),
  }
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
// `registration` only for a server jack adds itself to.
const cards = computed(() => servers.value.map(server => ({ server, registration: registersJack(server) ? registrationView(server) : null })))
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
      <UButton label="Connect Radarr or Sonarr" icon="i-ph-plus" @click="openForm(null)" />
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
        <UButton label="Connect Radarr or Sonarr" icon="i-ph-plus" @click="openForm(null)" />
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
          v-for="{ server, registration: view } in cards"
          :key="server.id"
          :name="server.name"
          :url="server.url"
          :initialized="server.initialized"
          :error="server.initializationError"
          :status="statusBadge(server)"
          @edit="openForm(server)"
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
          <!-- What jack set up in this server and whether the server has used it. -->
          <template v-if="view" #details>
            <div class="mt-2 space-y-1 pl-8 text-xs">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="text-muted">jack in {{ server.name }}:</span>
                <span v-if="view.testing" class="flex items-center gap-1 text-muted">
                  <UIcon name="i-ph-circle-notch" class="size-3.5 animate-spin" />
                  still testing
                </span>
                <template v-else-if="view.parts">
                  <template v-for="(part, i) in view.parts" :key="part.text">
                    <span v-if="i" class="text-dimmed">·</span>
                    <span :class="TONE_CLASS[part.tone]">{{ part.text }}</span>
                  </template>
                </template>
                <span v-else class="text-muted">not added yet</span>
                <UButton
                  label="Register again"
                  icon="i-ph-arrows-clockwise"
                  color="neutral"
                  variant="link"
                  size="xs"
                  class="p-0"
                  :loading="registering.has(server.id)"
                  @click="registerAgain(server)"
                />
              </div>

              <p v-if="view.message && !view.testing" :class="view.messageClass">
                {{ view.message }}
                <ULink v-if="view.fix" :to="settingsLink(view.fix.section)" raw class="font-medium underline">
                  {{ view.fix.label }}
                </ULink>
              </p>

              <p v-if="view.contact.state === 'reached'" class="text-muted" :title="formatDate(view.contact.at)">
                {{ server.name }} last reached jack {{ formatTimeAgo(view.contact.at, now) }}.
              </p>
              <p v-else-if="view.contact.state === 'waiting'" class="text-muted">
                {{ server.name }} hasn't reached jack yet.
              </p>
              <p v-else-if="view.contact.state === 'never'" class="text-warning">
                {{ server.name }} hasn't reached jack since jack added itself.
                <ULink :to="settingsLink('internal-url')" raw class="font-medium underline">
                  Change the address
                </ULink>
              </p>

              <p v-if="view.registerError" class="text-error">
                {{ view.registerError }}
              </p>
            </div>
          </template>
        </ConnectorCard>
      </div>
    </div>
  </SettingsSection>

  <UModal v-model:open="showForm" :title="formTitle" :dismissible="formDismissible">
    <template #body>
      <ServerRegistrationResult
        v-if="saved"
        :name="saved.name"
        :registration="saved.registration"
        :pending="saved.pending"
        @done="showForm = false"
      />
      <ServerForm
        v-else
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
        @dirty="formDirty = $event"
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
