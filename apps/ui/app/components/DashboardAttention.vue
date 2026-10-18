<script setup lang="ts">
import type { SetupRequiredState } from '~/composables/useSetupStatus'
import type { Overview } from '~/types/management'

const props = withDefaults(defineProps<{
  overview: Overview
  // The required setup steps (SetupChecklist). The green all-clear needs `done`:
  // with steps open, "no problems" would mislead even when nothing is failing, and
  // while the answer is unknown or a server is still connecting it would be a guess.
  setupState?: SetupRequiredState
  // Whether config/downloads exists; null when unknown.
  downloadsOn?: boolean | null
  // The user said "I only share" on the setup card.
  shareOnly?: boolean
}>(), { setupState: 'done', downloadsOn: null, shareOnly: false })

// How many example rows to list before collapsing the rest into "and N more".
const PREVIEW = 3

// Only connectors that actually failed to initialize are "issues" — ones still
// handshaking on startup (no error yet) are transient, not something to act on.
const unreachablePeers = computed(() => props.overview.peers.items.filter(p => !p.initialized && p.initializationError))
const unreachableServers = computed(() => props.overview.servers.items.filter(s => !s.initialized && s.initializationError))
const stuckImports = computed(() => props.overview.downloads.importQueued)
const failed = computed(() => props.overview.downloads.failed)
const failedCount = computed(() => props.overview.downloads.byStatus.failed ?? 0)
const queuedCount = computed(() => props.overview.downloads.byStatus.import_queued ?? 0)
// Live integrity warnings: only for in-flight/queued transfers — failed rows
// already carry their own error message below. The headline count uses the true
// backend total (`mismatched`); the rows are example detail from the capped lists.
const mismatchCount = computed(() => props.overview.downloads.mismatched)
const mismatches = computed(() =>
  [...props.overview.downloads.active, ...props.overview.downloads.importQueued]
    .filter(d => d.expectedBytesMismatch))

// Friends to download from, but no server that receives downloads. Sharing only is
// a valid setup, so this is information, unless downloads are on: then nothing can
// land anywhere and it counts as an issue.
const onlyShares = computed(() =>
  !props.shareOnly
  && props.overview.peers.total > 0
  && props.overview.servers.sources > 0
  && props.overview.servers.destinations === 0)
const onlySharesIsIssue = computed(() => onlyShares.value && props.downloadsOn === true)

// Each unreachable connector is its own fixable thing; download problems collapse
// to one line each. The count drives the badge.
const issueCount = computed(() =>
  unreachablePeers.value.length
  + unreachableServers.value.length
  + (queuedCount.value ? 1 : 0)
  + (failedCount.value ? 1 : 0)
  + (mismatchCount.value ? 1 : 0)
  + (onlySharesIsIssue.value ? 1 : 0))
const hasIssues = computed(() => issueCount.value > 0)

const nothingConfigured = computed(() => props.overview.peers.total === 0 && props.overview.servers.total === 0)

const allClearTitle = computed(() =>
  `No problems. ${plural(props.overview.peers.initialized, 'friend')} online, ${props.overview.servers.initialized} Radarr/Sonarr connected.`)

// Starts open on every visit, and opens again when a new issue arrives.
const open = ref(true)
watch(issueCount, (count, previous) => {
  if (count > previous)
    open.value = true
})

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
</script>

<template>
  <div class="space-y-4">
    <!-- Something needs doing. -->
    <UCard v-if="hasIssues" variant="subtle" :ui="{ body: '!p-0' }">
      <UCollapsible v-model:open="open" :ui="{ root: 'group' }">
        <button type="button" class="flex w-full items-center gap-3 px-4 py-3.5 text-left">
          <UIcon name="i-ph-caret-down" class="size-4 text-muted transition-transform group-data-[state=closed]:-rotate-90" />
          <span class="text-sm font-semibold text-highlighted">Needs attention</span>
          <UBadge class="ml-auto" color="error" variant="subtle" :label="plural(issueCount, 'issue')" />
        </button>

        <template #content>
          <div class="divide-y divide-default border-t border-default">
            <!-- Unreachable friends -->
            <div v-for="peer in unreachablePeers" :key="`peer-${peer.id}`" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-warning-circle" class="mt-0.5 size-4 shrink-0 text-error" />
              <p class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] text-sm text-default sm:basis-0">
                Can't reach your friend <span class="font-semibold">{{ peer.name }}</span>{{ peer.initializationError ? ':' : '' }}
                <span v-if="peer.initializationError" class="font-mono text-xs break-words text-error">{{ peer.initializationError }}</span>
              </p>
              <UButton :to="settingsLink('peers')" label="Edit" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Unreachable Radarr/Sonarr -->
            <div v-for="server in unreachableServers" :key="`server-${server.id}`" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-warning-circle" class="mt-0.5 size-4 shrink-0 text-error" />
              <p class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] text-sm text-default sm:basis-0">
                Can't reach <span class="font-semibold">{{ server.name }}</span>{{ server.initializationError ? ':' : '' }}
                <span v-if="server.initializationError" class="font-mono text-xs break-words text-error">{{ server.initializationError }}</span>
              </p>
              <UButton :to="settingsLink('servers')" label="Edit" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Downloads on, but nothing receives them -->
            <div v-if="onlySharesIsIssue" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-warning" class="mt-0.5 size-4 shrink-0 text-warning" />
              <p class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] text-sm text-default sm:basis-0">
                You only share. To get friends' movies and episodes into Radarr/Sonarr, turn on Download from friends for a Radarr or Sonarr.
              </p>
              <UButton :to="settingsLink('servers')" label="Edit Radarr & Sonarr" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Stuck imports -->
            <div v-if="queuedCount" class="flex gap-3 px-4 py-3">
              <UIcon name="i-ph-clock-countdown" class="mt-0.5 size-4 shrink-0 text-warning" />
              <div class="min-w-0">
                <p class="text-sm text-default">
                  {{ plural(queuedCount, 'download') }} waiting for Radarr/Sonarr to import
                </p>
                <p
                  v-for="d in stuckImports.slice(0, PREVIEW)"
                  :key="d.id"
                  class="mt-1 truncate text-xs text-muted"
                  :title="d.filename"
                >
                  <span class="text-toned">{{ d.filename }}</span>
                  · from {{ d.peerName }}
                  · waiting {{ formatAgo(d.completedAt ?? d.updatedAt) }}
                </p>
                <p v-if="queuedCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                  and {{ queuedCount - PREVIEW }} more
                </p>
              </div>
            </div>

            <!-- Failed downloads -->
            <div v-if="failedCount" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-x-circle" class="mt-0.5 size-4 shrink-0 text-error" />
              <div class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                <p class="text-sm text-default">
                  {{ plural(failedCount, 'download') }} failed
                </p>
                <p
                  v-for="d in failed.slice(0, PREVIEW)"
                  :key="d.id"
                  class="mt-1 truncate text-xs text-muted"
                  :title="d.error ?? undefined"
                >
                  <span class="text-toned">{{ d.filename }}</span>
                  · {{ d.error ?? 'unknown error' }}
                </p>
                <p v-if="failedCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                  and {{ failedCount - PREVIEW }} more
                </p>
              </div>
              <UButton to="/downloads" label="View downloads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Size mismatches -->
            <div v-if="mismatchCount" class="flex gap-3 px-4 py-3">
              <UIcon name="i-ph-warning" class="mt-0.5 size-4 shrink-0 text-warning" />
              <div class="min-w-0">
                <p class="text-sm text-default">
                  {{ plural(mismatchCount, 'download') }} {{ mismatchCount === 1 ? 'reports' : 'report' }} a size mismatch
                </p>
                <p
                  v-for="d in mismatches.slice(0, PREVIEW)"
                  :key="d.id"
                  class="mt-1 truncate text-xs text-muted"
                  :title="d.filename"
                >
                  <span class="text-toned">{{ d.filename }}</span> · from {{ d.peerName }}
                </p>
                <p v-if="mismatchCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                  and {{ mismatchCount - PREVIEW }} more
                </p>
              </div>
            </div>
          </div>
        </template>
      </UCollapsible>
    </UCard>

    <!-- Nothing failing, but nothing set up either: no green, no false comfort. -->
    <UAlert
      v-else-if="nothingConfigured || setupState === 'open'"
      color="neutral"
      variant="subtle"
      icon="i-ph-info"
      :title="nothingConfigured ? 'Nothing is failing. Finish setup to start sharing.' : 'Nothing is failing. Setup isn\'t finished yet.'"
    />

    <!-- All clear: one calm, factual line. -->
    <UAlert
      v-else-if="setupState === 'done'"
      color="success"
      variant="soft"
      icon="i-ph-check-circle"
      :title="allClearTitle"
    />

    <!-- Sharing only, with downloads off: worth knowing, not a problem. -->
    <UAlert
      v-if="onlyShares && !onlySharesIsIssue"
      color="info"
      variant="subtle"
      icon="i-ph-info"
      title="You only share."
      description="To get friends' movies and episodes into Radarr/Sonarr, turn on Download from friends for a Radarr or Sonarr."
      :actions="[{ label: 'Edit Radarr & Sonarr', to: settingsLink('servers'), color: 'info', variant: 'outline', size: 'sm' }]"
    />
  </div>
</template>
