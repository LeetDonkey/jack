<script setup lang="ts">
import type { Form, FormError, FormErrorEvent, FormSchema } from '@nuxt/ui'
import type { ComponentPublicInstance } from 'vue'
import type { BansSnapshot, SecurityConfig, SecurityConfigPatch, SecurityConfigResponse } from '~/types/management'
import type { SecurityListField } from '~/utils/security-form'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import { addressListError, splitAddressList } from '~/utils/address-list'
import { customListCount, hasListError, ignoredOnField, opensExceptions, SECURITY_ANCHORS, SECURITY_LIST_FIELDS, securityCanSave, securityFieldErrors } from '~/utils/security-form'

const { request, extractError, errorInfo } = useManagement()
const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

const { data: security, pending, error: loadError, refresh } = useLazyAsyncData(
  'security-config',
  () => request<SecurityConfigResponse | null>('config/security'),
)
const { data: bans, error: bansError, refresh: refreshBans } = useLazyAsyncData('security-bans', () => request<BansSnapshot>('security/bans'))

const timer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
  timer.value = setInterval(() => void refreshBans(), 30_000)
})
onBeforeUnmount(() => clearInterval(timer.value))
// The 30 s refresh would get there too; once jack is back there is no need to wait.
onJackBack(() => {
  if (bansError.value)
    void refreshBans()
})

const DEFAULTS = { maxFailures: 10, windowMinutes: 10, banMinutes: 60 }
// jack refuses more (security in apps/backend/src/lib/config.ts).
const MAX = { maxFailures: 1000, windowMinutes: 1440, banMinutes: 525_600 }

function blankState() {
  return {
    banEnabled: true,
    lanOnlyArrApis: true,
    publicOpenApi: false,
    maxFailures: null as number | null,
    windowMinutes: null as number | null,
    banMinutes: null as number | null,
    trustedProxies: '',
    neverBan: '',
    arrApiAlsoAllowed: '',
  }
}

const state = reactive(blankState())
const serverErrors = useServerFieldErrors(form, name => valueAtPath(state, name))
// Stored entries jack ignores, per field. Any save of the security settings drops
// all of them from config.jsonc, so each field's note says so, and Save stays
// available while there are any (securityCanSave).
const ignored = computed(() => Object.fromEntries(SECURITY_LIST_FIELDS.map(field => [field, ignoredOnField(security.value?.ignoredEntries, field)])) as Record<SecurityListField, string[]>)
const baseline = ref(JSON.stringify(blankState()))
const orDefault = (value: number, fallback: number) => (value === fallback ? null : value)

function seed(config: SecurityConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    state.banEnabled = config.banEnabled
    state.lanOnlyArrApis = config.lanOnlyArrApis
    state.publicOpenApi = config.publicOpenApi
    state.maxFailures = orDefault(config.maxFailures, DEFAULTS.maxFailures)
    state.windowMinutes = orDefault(config.windowMinutes, DEFAULTS.windowMinutes)
    state.banMinutes = orDefault(config.banMinutes, DEFAULTS.banMinutes)
    state.trustedProxies = (config.trustedProxies ?? []).join(', ')
    state.neverBan = (config.neverBan ?? []).join(', ')
    state.arrApiAlsoAllowed = (config.arrApiAlsoAllowed ?? []).join(', ')
  }
  baseline.value = JSON.stringify(state)
}

watch(() => security.value, seed, { immediate: true })

// Only the user's own changes count as unsaved; the ignored entries only make a
// save worth doing.
const dirty = computed(() => JSON.stringify(state) !== baseline.value)
const canSave = computed(() => securityCanSave(dirty.value, security.value?.ignoredEntries))
useUnsavedGuard().track('Security', dirty)
const saving = ref(false)
const { saveError, failed: saveFailed } = useSaveError()
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

// Empty sends null: Trusted proxies then falls back to every private address, and
// the other lists add nothing to the LAN.
function list(text: string) {
  const items = splitAddressList(text)
  return items.length ? items : null
}

type State = ReturnType<typeof blankState>

// The fields on screen: the ban settings and the extra LAN addresses only show
// while their switch is on.
function visibleFields(s: State): Set<string> {
  const fields = new Set(['banEnabled', 'lanOnlyArrApis', 'publicOpenApi', 'trustedProxies'])
  if (s.banEnabled)
    ['maxFailures', 'windowMinutes', 'banMinutes', 'neverBan'].forEach(f => fields.add(f))
  if (s.lanOnlyArrApis)
    fields.add('arrApiAlsoAllowed')
  return fields
}

// jack only matches real addresses, so a name such as "Nginx Proxy Manager" would
// be saved and then match nothing. Hidden lists are left to jack's own check.
function validate(s: State): FormError[] {
  const visible = visibleFields(s)
  return SECURITY_LIST_FIELDS.flatMap((name) => {
    const message = visible.has(name) ? addressListError(s[name]) : null
    return message ? [{ name, message }] : []
  })
}

// The address lists only matter for things outside the LAN, so they stay folded
// away. They open by themselves for entries jack ignores, for an error on one of
// them and for a link to them, since a closed group would hide what those are
// about.
const exceptionsOpen = ref(false)
watch(() => security.value?.ignoredEntries?.length, (count) => {
  if (count)
    exceptionsOpen.value = true
}, { immediate: true })
const customLists = computed(() => customListCount(state, visibleFields(state)))

// A link into the group (the update notice, the Logs page) opens it, and
// settings.vue scrolls to the target. A link to the hash already in the URL
// leaves route.hash alone, but afterEach still sees it.
const route = useRoute()
function openForLink(hash: string) {
  if (opensExceptions(hash))
    exceptionsOpen.value = true
}
openForLink(route.hash)
const stopAfterEach = useRouter().afterEach((to, _from, failure) => {
  if (!isNavigationFailure(failure, NavigationFailureType.aborted | NavigationFailureType.cancelled))
    openForLink(to.hash)
})
onBeforeUnmount(stopAfterEach)

// The group's fields stay mounted while it is closed (unmount-on-hide off), so
// the form keeps errors set on them. Reka only shows the content a render or two
// after `open` changes, though, and then grows it from nothing. An error can't be
// focused while the content is hidden, and scrolling to it while the content
// grows leaves it below the fold, so this waits for the open animation as well.
const exceptions = useTemplateRef<ComponentPublicInstance>('exceptions')
async function showExceptions() {
  const wasOpen = exceptionsOpen.value
  exceptionsOpen.value = true
  let content: Element | null = null
  for (let tick = 0; tick < 10; tick++) {
    const root = exceptions.value?.$el
    content = root instanceof HTMLElement ? root.querySelector('[data-slot="content"]') : null
    if (content && !content.hasAttribute('hidden'))
      break
    await nextTick()
  }
  if (!wasOpen && content)
    await untilAnimated(content)
}

// Reka measures the content a tick after showing it and starts the animation
// again, so this waits a frame before collecting the running animations.
async function untilAnimated(element: Element) {
  for (let round = 0; round < 3; round++) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const running = element.getAnimations()
    if (!running.length)
      return
    await Promise.allSettled(running.map(animation => animation.finished))
  }
}

async function onFormError(event: FormErrorEvent) {
  if (hasListError(event.errors))
    await showExceptions()
  void onError()
}

const FIELD_LABELS: Record<string, string> = {
  trustedProxies: 'Trusted proxies',
  neverBan: 'Never ban',
  arrApiAlsoAllowed: 'Radarr/Sonarr outside your LAN',
  maxFailures: 'Failures',
  windowMinutes: 'Within (minutes)',
  banMinutes: 'Ban for (minutes)',
}

// A refused save: jack's errors on the fields they name, or one message above
// Save for a field that isn't on screen.
async function showSaveError(err: unknown, patch: SecurityConfigPatch) {
  const info = errorInfo(err)
  const issues = info.issues.length ? info.issues : info.field && info.message ? [{ field: info.field, message: info.message }] : []
  const sent = { trustedProxies: patch.trustedProxies, neverBan: patch.neverBan, arrApiAlsoAllowed: patch.arrApiAlsoAllowed }
  const onScreen = securityFieldErrors(issues, sent, visibleFields(state))
  if (onScreen.length) {
    serverErrors.show(onScreen)
    // Closed, the group would hide the error.
    if (hasListError(onScreen))
      await showExceptions()
    void onError()
    return
  }
  const [hidden] = securityFieldErrors(issues, sent, new Set(Object.keys(FIELD_LABELS)))
  saveFailed(err, hidden
    ? `${FIELD_LABELS[hidden.name]}: ${hidden.message}`
    : extractError(err, 'Could not save the security settings.'))
}

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  serverErrors.clear()
  const patch: SecurityConfigPatch = {
    banEnabled: state.banEnabled,
    lanOnlyArrApis: state.lanOnlyArrApis,
    publicOpenApi: state.publicOpenApi,
    arrApiAlsoAllowed: list(state.arrApiAlsoAllowed),
    maxFailures: state.maxFailures,
    windowMinutes: state.windowMinutes,
    banMinutes: state.banMinutes,
    trustedProxies: list(state.trustedProxies),
    neverBan: list(state.neverBan),
  }
  let refused: { err: unknown } | null = null
  try {
    await request('config/security', { method: 'PATCH', body: patch })
    await refresh()
    saved.value = true
  }
  catch (err) {
    refused = { err }
  }
  finally {
    saving.value = false
  }
  // After `saving`: the fields are disabled until then, and a disabled field
  // can't take the focus.
  if (refused)
    await showSaveError(refused.err, patch)
}

function revert() {
  seed(security.value ?? null)
  serverErrors.clear()
  form.value?.clear()
  saveError.value = null
  saved.value = false
}

const lifting = ref<string | null>(null)
async function unban(ip: string) {
  lifting.value = ip
  try {
    await request(`security/bans/${encodeURIComponent(ip)}`, { method: 'DELETE' })
    await refreshBans()
  }
  finally {
    lifting.value = null
  }
}
</script>

<template>
  <SettingsSection
    id="security"
    title="Security"
    description="How jack's public port protects itself. The safest choices are the defaults."
  >
    <LoadErrorAlert v-if="loadError" :error="loadError" :retry="refresh" what="the security settings" />

    <p v-else-if="pending && security === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else ref="form" :state="state" :validate="validate" class="space-y-3" @submit="save" @error="onFormError">
      <!-- Link targets for the update notice and the Logs page (securityLink()). -->
      <UCard :id="SECURITY_ANCHORS.bans" variant="subtle" class="scroll-mt-6" :ui="{ body: 'space-y-4' }">
        <UFormField
          name="banEnabled"
          label="Ban repeated failures"
          description="An address that is refused (wrong or missing key, failed qBittorrent login) too often gets 403 on everything for a while. Your LAN is never banned."
        >
          <USwitch v-model="state.banEnabled" :disabled="saving" />
        </UFormField>

        <div v-if="state.banEnabled" class="grid gap-4 sm:grid-cols-3">
          <ConfigNumberField v-model="state.maxFailures" :disabled="saving" name="maxFailures" label="Failures" description="Refusals that trigger a ban." :default-value="DEFAULTS.maxFailures" :min="1" :max="MAX.maxFailures" />
          <ConfigNumberField v-model="state.windowMinutes" :disabled="saving" name="windowMinutes" label="Within (minutes)" description="Window the failures are counted in." :default-value="DEFAULTS.windowMinutes" :min="1" :max="MAX.windowMinutes" />
          <ConfigNumberField v-model="state.banMinutes" :disabled="saving" name="banMinutes" label="Ban for (minutes)" description="How long the address is refused." :default-value="DEFAULTS.banMinutes" :min="1" :max="MAX.banMinutes" />
        </div>
      </UCard>

      <UCard :id="SECURITY_ANCHORS.apis" variant="subtle" class="scroll-mt-6" :ui="{ body: 'space-y-4' }">
        <UFormField
          name="lanOnlyArrApis"
          label="Radarr/Sonarr APIs only on your LAN"
          description="The Torznab and qBittorrent APIs (/torznab, /api/v2) are only for your own Radarr and Sonarr. With this on, jack refuses them to every address outside your LAN, also when someone reaches jack through your reverse proxy. Friends don't use them."
        >
          <USwitch v-model="state.lanOnlyArrApis" :disabled="saving" />
        </UFormField>
        <UFormField
          name="publicOpenApi"
          label="Publish the API description"
          description="Answer /openapi.json on the public port. It lists jack's routes, no keys or settings. Off by default; the description is also in the docs."
        >
          <USwitch v-model="state.publicOpenApi" :disabled="saving" />
        </UFormField>
      </UCard>

      <UCollapsible :id="SECURITY_ANCHORS.exceptions" ref="exceptions" v-model:open="exceptionsOpen" :unmount-on-hide="false" class="scroll-mt-6">
        <UButton
          color="neutral"
          variant="subtle"
          block
          :ui="{ label: 'flex-1 text-left' }"
          label="Reverse proxy and exceptions"
          :icon="exceptionsOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
        >
          <template #trailing>
            <span v-if="customLists" class="text-xs text-muted">{{ customLists }} custom</span>
          </template>
        </UButton>

        <template #content>
          <UCard variant="subtle" class="mt-2" :ui="{ body: 'space-y-4' }">
            <p class="text-xs text-muted">
              Leave these empty unless something of yours reaches jack from outside your LAN, e.g. a
              reverse proxy on a VPS or Radarr over Tailscale.
            </p>
            <UFormField
              name="trustedProxies"
              label="Trusted proxies"
              description="The reverse proxy in front of jack, as IP addresses or ranges such as 172.18.0.0/16. Only requests from these may tell jack the visitor's real address. Empty trusts every private address, which covers a proxy on Unraid or elsewhere on your LAN. A list without your proxy's address stops bans for everything that comes through it."
            >
              <UInput v-model="state.trustedProxies" :disabled="saving" placeholder="Every private address" class="w-full font-mono" />
              <SecurityIgnoredEntries :values="ignored.trustedProxies" class="mt-1.5" />
            </UFormField>
            <!-- A hidden list still says what jack ignores in it. -->
            <UFormField
              v-if="state.banEnabled"
              name="neverBan"
              label="Never ban"
              description="Addresses outside your LAN that are never banned, as IP addresses or ranges, e.g. 100.64.0.0/10 for Tailscale. Your LAN is always exempt."
            >
              <UInput v-model="state.neverBan" :disabled="saving" placeholder="Nothing else" class="w-full font-mono" />
              <SecurityIgnoredEntries :values="ignored.neverBan" class="mt-1.5" />
            </UFormField>
            <SecurityIgnoredEntries
              v-else
              label="Never ban (shown while Ban repeated failures is on)"
              :values="ignored.neverBan"
            />
            <UFormField
              v-if="state.lanOnlyArrApis"
              :id="SECURITY_ANCHORS.arrOutsideLan"
              name="arrApiAlsoAllowed"
              label="Radarr/Sonarr outside your LAN"
              description="Lets a Radarr or Sonarr outside your LAN use the Radarr/Sonarr APIs too. Enter its IP address or range, e.g. 100.64.0.0/10 for Tailscale, or your VPS's IP address."
              class="scroll-mt-6"
            >
              <UInput v-model="state.arrApiAlsoAllowed" :disabled="saving" placeholder="None" class="w-full font-mono" />
              <SecurityIgnoredEntries :values="ignored.arrApiAlsoAllowed" class="mt-1.5" />
            </UFormField>
            <SecurityIgnoredEntries
              v-else
              :id="SECURITY_ANCHORS.arrOutsideLan"
              label="Radarr/Sonarr outside your LAN (shown while Radarr/Sonarr APIs only on your LAN is on)"
              :values="ignored.arrApiAlsoAllowed"
              class="scroll-mt-6"
            />
          </UCard>
        </template>
      </UCollapsible>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="Applies right away." />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <p v-if="showFixHint" class="mr-auto text-xs text-error">
          Fix the highlighted fields to save.
        </p>
        <p v-else class="mr-auto text-xs text-muted">
          Clear a field to use jack's default.
        </p>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!canSave" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>

    <UCard variant="subtle" :ui="{ body: 'space-y-2' }">
      <p class="text-sm font-medium text-highlighted">
        Banned addresses
      </p>
      <!-- A failed load empties the list, which must not read as "nobody". -->
      <p v-if="!bans && bansError" class="text-xs text-muted">
        Can't load the list right now. It updates by itself once jack answers.
      </p>
      <p v-else-if="!bans" class="flex items-center gap-2 text-xs text-muted">
        <UIcon name="i-ph-circle-notch" class="size-3.5 animate-spin" />
        Loading…
      </p>
      <p v-else-if="!bans.bans.length" class="text-xs text-muted">
        Nobody is banned.
      </p>
      <div v-for="ban in bans?.bans ?? []" :key="ban.ip" class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-default p-2">
        <div class="min-w-0">
          <p class="font-mono text-sm text-default">
            {{ ban.ip }}
          </p>
          <p class="text-xs text-muted">
            {{ ban.failures }} failures, last {{ ban.reason }} · banned {{ formatAgo(ban.bannedAt) }} · until {{ formatDate(ban.bannedUntil) }}
          </p>
        </div>
        <UButton label="Lift ban" size="xs" color="neutral" variant="soft" :loading="lifting === ban.ip" @click="unban(ban.ip)" />
      </div>

      <template v-if="bans?.failing.length">
        <p class="pt-2 text-sm font-medium text-highlighted">
          Failing, not banned yet
        </p>
        <p v-for="f in bans.failing" :key="f.ip" class="font-mono text-xs text-muted">
          {{ f.ip }} · {{ f.failures }} failures · last {{ formatAgo(f.lastAt) }}
        </p>
      </template>
    </UCard>
  </SettingsSection>
</template>
