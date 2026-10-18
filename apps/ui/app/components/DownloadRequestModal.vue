<script setup lang="ts">
import type { CatalogRequestOptions } from '~/types/activity'
import type { CatalogRequestPayload, CatalogTitle } from '~/types/management'

const props = withDefaults(defineProps<{
  open: boolean
  title: CatalogTitle | null
  submitting?: boolean
  error?: string | null
  lockedPeerId?: string
  // GET catalog/request-options, loaded by the catalog page (null until it answers).
  options: CatalogRequestOptions | null
  optionsStatus?: 'idle' | 'loading' | 'error'
  // A warning per friend id whose library may be out of date (offline, or not refreshed).
  peerWarnings?: Record<string, string>
}>(), { submitting: false, error: null, lockedPeerId: undefined, optionsStatus: 'idle', peerWarnings: () => ({}) })
const emit = defineEmits<{ 'update:open': [boolean], 'confirm': [CatalogRequestPayload], 'reloadOptions': [] }>()

// Codebase convention (see settings.vue) is a computed get/set bridge for v-model,
// not defineModel (which this app does not use).
const open = computed({ get: () => props.open, set: v => emit('update:open', v) })

const candidates = computed(() =>
  (props.options?.servers ?? []).filter(s => props.title && s.mediaType === props.title.mediaType))
const arr = computed(() => props.title?.mediaType === 'tv' ? 'Sonarr' : 'Radarr')
// The catalog disables Download for these; the dialog says it again in case they
// changed while it was open.
const inactiveReason = computed(() => props.options?.downloadsInactiveReason ?? null)

// USelect's v-model does not accept null; undefined behaves identically under the
// `!= null` / `== null` loose checks below, so we use undefined for "unset".
const peers = computed(() => props.title?.peers ?? [])
const peerId = ref<string | undefined>(undefined)
const serverId = ref<string | undefined>(undefined)
const rootFolderPath = ref<string | undefined>(undefined)

const server = computed(() => candidates.value.find(s => s.id === serverId.value) ?? null)
const peerWarning = computed(() => peerId.value ? props.peerWarnings[peerId.value] ?? null : null)

// Honor a peer picked from the detail view's per-peer cards (lockedPeerId); otherwise
// reset to the first peer whenever the title changes, so a multi-peer title always
// opens on its first peer regardless of a prior selection (matches the AC).
watch([() => props.title?.key, () => props.lockedPeerId], () => {
  peerId.value = props.lockedPeerId ?? peers.value[0]?.id
}, { immediate: true })

watch(candidates, (list) => {
  if (list.length && !list.some(s => s.id === serverId.value))
    serverId.value = list[0]!.id
}, { immediate: true })

watch(server, (s) => {
  rootFolderPath.value = s?.rootFolders[0]?.path ?? undefined
}, { immediate: true })

const canSubmit = computed(() => Boolean(!inactiveReason.value && peerId.value && serverId.value && rootFolderPath.value))

function onConfirm() {
  if (!canSubmit.value || !peerId.value || !serverId.value || !rootFolderPath.value)
    return
  emit('confirm', { peerId: peerId.value, serverId: serverId.value, rootFolderPath: rootFolderPath.value })
}
</script>

<template>
  <UModal v-model:open="open" title="Add to your library" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p v-if="!options && optionsStatus !== 'error'" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading options…
      </p>

      <div v-else-if="!options" class="space-y-3">
        <p class="text-sm text-muted">
          jack couldn't list where to send this. It may be restarting.
        </p>
        <UButton label="Try again" size="sm" color="neutral" variant="outline" @click="emit('reloadOptions')" />
      </div>

      <div v-else-if="inactiveReason === 'off'" class="space-y-3">
        <p class="text-sm text-muted">
          Downloads are off, so jack can't download this.
        </p>
        <UButton label="Turn on downloads" :to="settingsLink('downloads')" size="sm" color="neutral" variant="outline" @click="open = false" />
      </div>

      <div v-else-if="inactiveReason === 'restartPending'" class="space-y-1">
        <p class="text-sm text-default">
          Restart the jack container first.
        </p>
        <p class="text-sm text-muted">
          Downloads were turned on after jack started. Unraid: <span class="whitespace-nowrap">{{ RESTART_STEPS }}</span>.
        </p>
      </div>

      <div v-else-if="candidates.length === 0" class="space-y-3">
        <p class="text-sm text-muted">
          No {{ arr }} that jack can reach has Download from friends turned on.
        </p>
        <UButton
          label="Open Radarr & Sonarr"
          :to="settingsLink('servers')"
          size="sm"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
      </div>

      <div v-else class="space-y-4">
        <UFormField v-if="peers.length > 1 && !lockedPeerId" label="Friend">
          <USelect
            v-model="peerId"
            :items="peers.map(p => ({ label: p.name, value: p.id }))"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Send to">
          <USelect
            v-model="serverId"
            :items="candidates.map(s => ({ label: s.name, value: s.id }))"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Root folder">
          <USelect
            v-model="rootFolderPath"
            :items="(server?.rootFolders ?? []).map(f => ({ label: f.path, value: f.path }))"
            class="w-full"
          />
        </UFormField>

        <!-- Not a block: the health check can be up to 5 minutes old. -->
        <UAlert v-if="peerWarning" color="warning" variant="subtle" icon="i-ph-warning" :title="peerWarning" />

        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
      </div>
    </template>

    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton
        label="Download"
        icon="i-ph-download-simple"
        :disabled="!canSubmit"
        :loading="submitting"
        @click="onConfirm"
      />
    </template>
  </UModal>
</template>
