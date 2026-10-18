<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
import type { ApiKey, ApiKeyInput, CreatedApiKey, ExternalJackConfig, JackConfig, PeerInput } from '~/types/management'

const { request, extractError } = useManagement()
const version = useRuntimeConfig().public.appVersion

const { data, pending, error, refresh } = await useAsyncData('api-keys', () =>
  request<ApiKey[]>('api-keys'))

const keys = computed(() => data.value ?? [])

// Jack config (config.jack). Separate async key from the api-keys load above.
// Surface pending/error so a failed GET never renders a blank form a user could
// accidentally save over (mirrors the api-keys load states below).
const { data: jack, pending: jackPending, error: jackLoadError, refresh: refreshJack }
  = await useAsyncData('jack-config', () => request<JackConfig | null>('config/jack'))

// TMDB is only used when a key is set in config.jsonc; About credits it then.
const { data: tmdbStatus } = await useAsyncData('tmdb-status', () =>
  request<{ configured: boolean, ok: boolean }>('catalog/tmdb/status'))

const jackSubmitting = ref(false)
const jackError = ref<string | null>(null)
const jackSaved = ref(false)
const jackFormRevision = ref(0)
const showQuickLink = ref(false)
const showQuickLinkImport = ref(false)
const quickLinkSubmitting = ref(false)
const quickLinkError = ref<string | null>(null)
const quickLinkSaved = ref(false)
const quickLinkFormRevision = ref(0)
const showRemoveQuickLinking = ref(false)
const removingQuickLinking = ref(false)
const peersSection = ref<{ reviewImported: (peer: PeerInput) => void } | null>(null)

async function saveJack(input: JackConfig) {
  jackSubmitting.value = true
  jackError.value = null
  jackSaved.value = false
  try {
    await request('config/jack', { method: 'PATCH', body: input })
    await refreshJack()
    jackFormRevision.value++
    jackSaved.value = true
  }
  catch (err) {
    jackError.value = extractError(err, 'Could not save the jack settings.')
  }
  finally {
    jackSubmitting.value = false
  }
}

async function saveQuickLinking(external: ExternalJackConfig) {
  if (!jack.value) {
    quickLinkError.value = 'Save the jack section before setting up quick linking.'
    return
  }
  quickLinkSubmitting.value = true
  quickLinkError.value = null
  quickLinkSaved.value = false
  try {
    await request('config/jack/external', { method: 'PATCH', body: external })
    await refreshJack()
    quickLinkFormRevision.value++
    quickLinkSaved.value = true
  }
  catch (err) {
    quickLinkError.value = extractError(err, 'Could not save the quick linking settings.')
  }
  finally {
    quickLinkSubmitting.value = false
  }
}

async function removeQuickLinking() {
  removingQuickLinking.value = true
  quickLinkError.value = null
  quickLinkSaved.value = false
  try {
    await request('config/jack/external', { method: 'DELETE' })
    await refreshJack()
    quickLinkFormRevision.value++
    showRemoveQuickLinking.value = false
  }
  catch (err) {
    quickLinkError.value = extractError(err, 'Could not remove the quick linking settings.')
  }
  finally {
    removingQuickLinking.value = false
  }
}

function reviewQuickLink(peer: PeerInput) {
  peersSection.value?.reviewImported(peer)
}

// Same condition as Quick linking's own Generate button.
const canGenerateQuickLink = computed(() => Boolean(jack.value?.external?.url && jack.value?.external?.instanceName))

// Deep links (settingsLink()). The page scrolls inside the dashboard panel body,
// so vue-router's scrollBehavior can't reach the section. Sections above the
// target load lazily and push it down as they render, so it is scrolled back
// into view until the layout settles or the user scrolls.
const route = useRoute()
const content = ref<HTMLElement | null>(null)
let stopFollowing: (() => void) | undefined
let scrollRun = 0

async function scrollToHash(hash: string) {
  stopFollowing?.()
  const run = ++scrollRun
  const id = decodeURIComponent(hash.slice(1))
  if (!id)
    return
  await nextTick()
  if (run !== scrollRun)
    return
  const scroll = () => document.getElementById(id)?.scrollIntoView({ block: 'start' })
  scroll()
  if (!content.value)
    return

  const observer = new ResizeObserver(scroll)
  observer.observe(content.value)
  const userInput = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  let timeout: ReturnType<typeof setTimeout> | undefined
  function stop() {
    observer.disconnect()
    clearTimeout(timeout)
    userInput.forEach(type => window.removeEventListener(type, stop))
    stopFollowing = undefined
  }
  timeout = setTimeout(stop, 5_000)
  userInput.forEach(type => window.addEventListener(type, stop, { passive: true }))
  stopFollowing = stop
}

onMounted(() => void scrollToHash(route.hash))
// Every navigation within this page, including a link to the hash already in the
// URL: vue-router drops that one as a duplicate, so a watch on route.hash would
// never see it, but afterEach still runs.
const stopAfterEach = useRouter().afterEach((to, from) => {
  if (to.path === from.path && to.path === route.path)
    void scrollToHash(to.hash)
})
onBeforeUnmount(() => {
  stopAfterEach()
  stopFollowing?.()
})

const showForm = ref(false)
const editTarget = ref<ApiKey | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

// The one-time reveal: set after a successful create, cleared when dismissed.
const created = ref<CreatedApiKey | null>(null)
const createdOpen = computed({
  get: () => created.value !== null,
  set: (v) => {
    if (!v)
      dismissReveal()
  },
})
const copied = ref(false)

const confirmTarget = ref<ApiKey | null>(null)
// Kept after the dialog closes so its text doesn't change while it animates out.
const lastRevoke = ref<ApiKey | null>(null)
watch(confirmTarget, (key) => {
  if (key)
    lastRevoke.value = key
})
const revoking = ref(false)
const revokeError = ref<string | null>(null)
const confirmOpen = computed({
  get: () => confirmTarget.value !== null,
  set: (v) => {
    if (!v)
      closeConfirm()
  },
})

// Expiration as an at-a-glance signal rather than a raw timestamp.
function expiryInfo(key: ApiKey): { label: string, color: BadgeProps['color'] } {
  if (!key.expiresAt)
    return { label: 'Never expires', color: 'neutral' }
  const ms = new Date(key.expiresAt).getTime() - Date.now()
  if (ms <= 0)
    return { label: 'Expired', color: 'error' }
  const days = Math.ceil(ms / 86_400_000)
  if (days <= 7)
    return { label: `Expires in ${days}d`, color: 'warning' }
  return { label: `Expires ${new Date(key.expiresAt).toLocaleDateString()}`, color: 'neutral' }
}

// One muted meta line per key: its description (if any) then when it was created.
function keyMeta(key: ApiKey): string {
  const created = `Created ${formatAgo(key.createdAt)} ago`
  return key.description ? `${key.description} · ${created}` : created
}

function openAdd() {
  editTarget.value = null
  formError.value = null
  showForm.value = true
}
function openEdit(key: ApiKey) {
  editTarget.value = key
  formError.value = null
  showForm.value = true
}

async function submit(input: ApiKeyInput) {
  submitting.value = true
  formError.value = null
  try {
    if (editTarget.value) {
      await request(`api-keys/${editTarget.value.id}`, { method: 'PATCH', body: input })
      showForm.value = false
    }
    else {
      const key = await request<CreatedApiKey>('api-keys', { method: 'POST', body: input })
      showForm.value = false
      // Hand straight off to the reveal — this is the only chance to copy it.
      created.value = key
    }
    await refresh()
  }
  catch (err) {
    formError.value = extractError(err, 'Could not save the key.')
  }
  finally {
    submitting.value = false
  }
}

async function copyKey() {
  if (!created.value)
    return
  await navigator.clipboard.writeText(created.value.key)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

function dismissReveal() {
  created.value = null
  copied.value = false
}

function closeConfirm() {
  confirmTarget.value = null
  revokeError.value = null
}
async function confirmRevoke() {
  if (!confirmTarget.value)
    return
  revoking.value = true
  revokeError.value = null
  try {
    await request(`api-keys/${confirmTarget.value.id}`, { method: 'DELETE' })
    confirmTarget.value = null
    await refresh()
  }
  catch (err) {
    revokeError.value = extractError(err, 'Could not revoke the key.')
  }
  finally {
    revoking.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings" />
    </template>

    <template #body>
      <div ref="content" class="space-y-10">
        <!-- jack: how Radarr/Sonarr reach it -->
        <SettingsSection
          id="internal-url"
          title="jack"
          description="How Radarr and Sonarr reach jack."
        >
          <UAlert v-if="jackLoadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the jack settings." />

          <p v-else-if="jackPending" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
            Loading…
          </p>

          <UCard v-else variant="subtle" :ui="{ body: 'space-y-4' }">
            <!-- Re-key after a successful refresh so the form seeds its state from the saved config. -->
            <JackConfigForm
              :key="jackFormRevision"
              :initial="jack"
              :submitting="jackSubmitting"
              :error="jackError"
              @submit="saveJack"
            />
            <UAlert
              v-if="jackSaved"
              color="success"
              variant="soft"
              icon="i-ph-check-circle"
              title="Saved. jack updates Radarr/Sonarr with the new address."
            />
          </UCard>
        </SettingsSection>

        <USeparator />

        <DownloadsSection />

        <USeparator />

        <ServersSection />

        <USeparator />

        <template v-if="!jackPending && !jackLoadError">
          <QuickLinkingSection
            :key="quickLinkFormRevision"
            :available="Boolean(jack)"
            :initial="jack?.external"
            :submitting="quickLinkSubmitting"
            :error="quickLinkError"
            :saved="quickLinkSaved"
            @submit="saveQuickLinking"
            @generate="() => { showQuickLink = true }"
            @import="() => { showQuickLinkImport = true }"
            @remove="() => { showRemoveQuickLinking = true }"
          />

          <USeparator />
        </template>

        <PeersSection ref="peersSection" />

        <USeparator />

        <!-- Keys you issue, one per friend -->
        <SettingsSection
          id="access-keys"
          title="Friend access keys"
          description="A key lets one friend's jack search and download from you. Give each friend their own; quick links create one for you. Radarr and Sonarr don't need one: jack sets up their keys itself."
        >
          <template #aside>
            <UButton label="Create key" icon="i-ph-plus" @click="openAdd" />
          </template>

          <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the friend access keys." />

          <p v-else-if="pending" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
            Loading…
          </p>

          <UCard v-else-if="keys.length === 0" variant="subtle">
            <div class="flex flex-col items-center gap-3 py-6 text-center">
              <UIcon name="i-ph-key" class="size-8 text-dimmed" />
              <p class="text-sm text-muted">
                Nobody can download from you yet. Generate a quick link for a friend.
              </p>
              <div class="flex flex-wrap justify-center gap-2">
                <UButton v-if="canGenerateQuickLink" label="Generate quick link" icon="i-ph-link" @click="() => { showQuickLink = true }" />
                <UButton v-else label="Set the address friends use" icon="i-ph-link" :to="settingsLink('public-address')" />
                <UButton label="Create key" icon="i-ph-plus" color="neutral" variant="outline" @click="openAdd" />
              </div>
            </div>
          </UCard>

          <div v-else class="space-y-2">
            <UCard v-for="key in keys" :key="key.id" variant="subtle" :ui="{ body: 'sm:p-4' }">
              <div class="flex items-center gap-3">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
                  <UIcon name="i-ph-key" class="size-4 text-muted" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2">
                    <span v-if="key.name" class="truncate font-medium text-default" :title="key.name">{{ key.name }}</span>
                    <span v-else class="truncate font-medium text-muted">Unnamed key</span>
                    <span class="shrink-0 font-mono text-xs text-dimmed">#{{ key.id }}</span>
                  </div>
                  <p class="truncate text-xs text-muted" :title="formatDate(key.createdAt)">
                    {{ keyMeta(key) }}
                  </p>
                </div>
                <UBadge v-bind="expiryInfo(key)" variant="subtle" />
                <UButton icon="i-ph-pencil-simple" color="neutral" variant="ghost" size="sm" aria-label="Edit key" @click="openEdit(key)" />
                <UButton icon="i-ph-trash" color="neutral" variant="ghost" size="sm" aria-label="Revoke key" @click="() => { confirmTarget = key }" />
              </div>
            </UCard>
          </div>
        </SettingsSection>

        <USeparator />

        <DiscoverySection />

        <USeparator />

        <BandwidthSection />

        <USeparator />

        <TorznabSection />

        <USeparator />

        <NotificationsSection />

        <USeparator />

        <SecuritySection />

        <USeparator />

        <!-- About / Credits — also the home for required third-party attribution. -->
        <SettingsSection
          id="about"
          title="About"
          description="What this is, and the data it relies on."
        >
          <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
            <!-- jack's own mark: stated first, in brand color, at full size. -->
            <div class="flex items-center gap-3">
              <UIcon name="i-ph-plugs-connected" class="size-7 shrink-0 text-primary" />
              <div class="min-w-0">
                <div class="flex items-baseline gap-2">
                  <span class="text-base font-semibold tracking-tight text-highlighted">jack</span>
                  <span class="font-mono text-xs text-dimmed">v{{ version }}</span>
                </div>
                <p class="text-xs text-muted">
                  Share Radarr and Sonarr libraries with friends
                </p>
              </div>
            </div>

            <!-- TMDB attribution, only while jack uses a TMDB key. Deliberately quieter
                 than the jack mark above, per TMDB's terms. -->
            <USeparator v-if="tmdbStatus?.configured" />
            <div v-if="tmdbStatus?.configured" class="flex items-start gap-3">
              <img src="/tmdb.svg" alt="The Movie Database (TMDB)" class="mt-0.5 h-4 w-auto shrink-0">
              <p class="text-xs leading-relaxed text-muted">
                This product uses the TMDB API but is not endorsed or certified by TMDB.
              </p>
            </div>
          </UCard>
        </SettingsSection>
      </div>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="showForm" :title="editTarget ? 'Edit friend access key' : 'Create friend access key'">
    <template #body>
      <ApiKeyForm
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
      />
    </template>
  </UModal>

  <QuickLinkImportModal v-model:open="showQuickLinkImport" @imported="reviewQuickLink" />

  <UModal v-model:open="showRemoveQuickLinking" title="Remove quick linking settings" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        Remove the instance name, external URL and proxy headers? Links you already sent keep working until you revoke their keys under Friend access keys.
      </p>
      <UAlert v-if="quickLinkError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="quickLinkError" />
    </template>
    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton label="Remove" color="error" :loading="removingQuickLinking" @click="removeQuickLinking" />
    </template>
  </UModal>

  <QuickLinkGenerateModal
    v-if="jack?.external?.url"
    v-model:open="showQuickLink"
    :instance-name="jack.external.instanceName ?? ''"
    @generated="refresh"
  />

  <UModal v-model:open="createdOpen" title="Friend access key created" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-warning"
          title="Copy this key now"
          description="This is the only time it's shown. Send it to your friend now or store it somewhere safe."
        />

        <UFormField :label="created?.name || 'Unnamed key'">
          <UButtonGroup class="w-full">
            <UInput :model-value="created?.key" readonly class="flex-1 font-mono" :ui="{ base: 'text-success' }" />
            <UButton
              :icon="copied ? 'i-ph-check' : 'i-ph-copy'"
              :color="copied ? 'success' : 'neutral'"
              variant="subtle"
              :label="copied ? 'Copied' : 'Copy'"
              @click="copyKey"
            />
          </UButtonGroup>
        </UFormField>
      </div>
    </template>
    <template #footer="{ close }">
      <UButton label="Done" color="neutral" @click="close" />
    </template>
  </UModal>

  <UModal v-model:open="confirmOpen" title="Revoke access" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        <template v-if="lastRevoke?.name">
          Revoke <strong>{{ lastRevoke.name }}</strong>'s access? Their jack can no longer search or download from you.
        </template>
        <template v-else>
          Revoke <strong>key #{{ lastRevoke?.id }}</strong>? The jack using it can no longer search or download from you.
        </template>
        This can't be undone.
      </p>
      <UAlert v-if="revokeError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="revokeError" />
    </template>
    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton label="Revoke" color="error" :loading="revoking" @click="confirmRevoke" />
    </template>
  </UModal>
</template>
