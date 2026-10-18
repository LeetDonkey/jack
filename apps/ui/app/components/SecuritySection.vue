<script setup lang="ts">
import type { BansSnapshot, SecurityConfig, SecurityConfigPatch } from '~/types/management'

const { request, extractError } = useManagement()

const { data: security, pending, error: loadError, refresh } = useLazyAsyncData(
  'security-config',
  () => request<SecurityConfig | null>('config/security'),
)
const { data: bans, refresh: refreshBans } = useLazyAsyncData('security-bans', () => request<BansSnapshot>('security/bans'))

const timer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
  timer.value = setInterval(() => void refreshBans(), 30_000)
})
onBeforeUnmount(() => clearInterval(timer.value))

const DEFAULTS = { maxFailures: 10, windowMinutes: 10, banMinutes: 60 }

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

const dirty = computed(() => JSON.stringify(state) !== baseline.value)
useUnsavedGuard().track('Security', dirty)
const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

// Empty means "use the default" (private network ranges).
const SEPARATORS = /[\s,]+/
function list(text: string) {
  const items = text.split(SEPARATORS).map(s => s.trim()).filter(Boolean)
  return items.length ? items : null
}

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
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
  try {
    await request('config/security', { method: 'PATCH', body: patch })
    await refresh()
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the security settings.')
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(security.value ?? null)
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
    description="How jack's public port protects itself. Everything here is on by default."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the security settings." />

    <p v-else-if="pending && security === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else :state="state" class="space-y-3" @submit="save">
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <UFormField
          name="banEnabled"
          label="Ban repeated failures"
          description="An address that is refused (wrong or missing key, failed qBittorrent login) too often gets 403 on everything for a while. Your LAN is never banned."
        >
          <USwitch v-model="state.banEnabled" :disabled="saving" />
        </UFormField>

        <div v-if="state.banEnabled" class="grid gap-4 sm:grid-cols-3">
          <ConfigNumberField v-model="state.maxFailures" :disabled="saving" name="maxFailures" label="Failures" description="Refusals that trigger a ban." :default-value="DEFAULTS.maxFailures" :min="1" />
          <ConfigNumberField v-model="state.windowMinutes" :disabled="saving" name="windowMinutes" label="Within (minutes)" description="Window the failures are counted in." :default-value="DEFAULTS.windowMinutes" :min="1" />
          <ConfigNumberField v-model="state.banMinutes" :disabled="saving" name="banMinutes" label="Ban for (minutes)" description="How long the address is refused." :default-value="DEFAULTS.banMinutes" :min="1" />
        </div>

        <UFormField
          name="trustedProxies"
          label="Trusted proxies"
          description="Addresses or CIDR ranges of the reverse proxy in front of jack (e.g. Nginx Proxy Manager). Only requests from these may name the real client in X-Forwarded-For / X-Real-IP. The list must include the address your proxy connects from, or jack refuses the Radarr/Sonarr APIs to everything coming through it. Empty means private network ranges."
        >
          <UInput v-model="state.trustedProxies" :disabled="saving" placeholder="Private ranges" class="w-full font-mono" />
        </UFormField>
        <UFormField v-if="state.banEnabled" name="neverBan" label="Never ban" description="Addresses or CIDR ranges that are never counted. Empty means your LAN and loopback.">
          <UInput v-model="state.neverBan" :disabled="saving" placeholder="Private ranges" class="w-full font-mono" />
        </UFormField>
      </UCard>

      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <UFormField
          name="lanOnlyArrApis"
          label="Radarr/Sonarr APIs only on your LAN"
          description="The Torznab and qBittorrent APIs (/torznab, /api/v2) are only for your own Radarr and Sonarr. With this on, jack refuses them to every address outside your LAN, also when someone reaches jack through your reverse proxy. Friends don't use them."
        >
          <USwitch v-model="state.lanOnlyArrApis" :disabled="saving" />
        </UFormField>
        <UFormField
          v-if="state.lanOnlyArrApis"
          name="arrApiAlsoAllowed"
          label="Also allow"
          description="Addresses or CIDR ranges allowed on top of your LAN, for a Radarr or Sonarr that reaches jack from elsewhere, e.g. over Tailscale (100.64.0.0/10) or from a VPS."
        >
          <UInput v-model="state.arrApiAlsoAllowed" :disabled="saving" placeholder="Nothing else" class="w-full font-mono" />
        </UFormField>
        <UFormField
          name="publicOpenApi"
          label="Publish the API description"
          description="Answer /openapi.json on the public port. It lists jack's routes, no keys or settings. Off by default; the description is also in the docs."
        >
          <USwitch v-model="state.publicOpenApi" :disabled="saving" />
        </UFormField>
      </UCard>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="Applies right away." />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <p class="mr-auto text-xs text-muted">
          Clear a field to use jack's default.
        </p>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>

    <UCard variant="subtle" :ui="{ body: 'space-y-2' }">
      <p class="text-sm font-medium text-highlighted">
        Banned addresses
      </p>
      <p v-if="!bans?.bans.length" class="text-xs text-muted">
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
