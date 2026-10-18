<script setup lang="ts">
import type { Overview } from '~/types/management'

const { request } = useManagement()

const overviewRequest = useAsyncData('overview', () => request<Overview>('overview'))
const { data: overview, error, refresh } = overviewRequest

// Setup checklist state. Awaited together with the overview so the first render
// already knows whether setup is open: no card popping in, no green flash.
const setup = useSetupStatus(overview)
await Promise.all([overviewRequest, setup.whenLoaded()])

const { connected, hasConnectedOnce } = useManagementStream<Overview>('overview/stream', (snapshot) => {
  overview.value = snapshot
  error.value = undefined
})

// Requests that failed while jack was unreachable get another go once the stream
// reaches it again.
watch(connected, (isConnected) => {
  if (isConnected)
    void setup.refreshMissing()
})

async function retry() {
  await Promise.all([refresh(), setup.refreshMissing()])
}

// Content is held back only until it first renders. A later refetch of missing
// setup data leaves the dashboard on screen instead of swapping it for "Loading…".
const shownOnce = ref(false)
watch(() => Boolean(overview.value) && setup.settled, (shown) => {
  if (shown)
    shownOnce.value = true
}, { immediate: true })

// Peer colors from the shared settings store (single source, consistent across views).
const { settings } = useSettings()
const peerTextClass = (id: string) => settings.value?.peerColors.get(id)?.text ?? peerColorTextClass(id)
</script>

<template>
  <UDashboardPanel id="dashboard">
    <template #header>
      <UDashboardNavbar title="Dashboard">
        <template #right>
          <LiveBadge :connected="connected" :has-connected-once="hasConnectedOnce" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <LoadErrorAlert v-if="error && !overview" :error="error" :retry="retry" />

      <!-- Held back while the setup data is still on its way, so the dashboard never
           renders first without the setup card. -->
      <div v-else-if="overview && (setup.settled || shownOnce)" class="space-y-8">
        <!-- What needs doing, first: setup, then problems. -->
        <div class="space-y-4">
          <SetupChecklist :status="setup" />
          <DashboardAttention
            :overview="overview"
            :setup-state="setup.requiredState"
            :downloads-on="setup.ready ? setup.downloadsOn : null"
            :share-only="setup.shareOnly"
          />
        </div>

        <!-- Lifetime totals — the satisfying numbers. -->
        <section>
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Lifetime
          </h2>
          <div class="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <StatCard label="Imported" :value="overview.downloads.byStatus.imported ?? 0" hint="media files" icon="i-ph-tray-arrow-down" />
            <StatCard label="Downloaded from friends" :value="formatBytes(overview.downloads.bytesMoved)" icon="i-ph-swap" />
            <StatCard label="Downloads started" :value="overview.downloads.total" icon="i-ph-download-simple" class="col-span-2 lg:col-span-1" />
          </div>
        </section>

        <!-- Live download activity. -->
        <section>
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-muted">
              Downloads
            </h2>
            <UButton to="/downloads" label="View all downloads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="px-0" />
          </div>

          <UCard variant="subtle" :ui="{ body: '!p-0' }">
            <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-default px-5 py-4">
              <span class="flex items-baseline gap-2">
                <span class="text-xl font-semibold tabular-nums text-primary">{{ overview.downloads.byStatus.downloading ?? 0 }}</span>
                <span class="text-sm text-muted">Downloading</span>
              </span>
              <span class="flex items-baseline gap-2">
                <span class="text-xl font-semibold tabular-nums text-warning">{{ overview.downloads.byStatus.import_queued ?? 0 }}</span>
                <span class="text-sm text-muted">Queued for import</span>
              </span>
              <span class="flex items-baseline gap-2">
                <span class="text-xl font-semibold tabular-nums text-error">{{ overview.downloads.byStatus.failed ?? 0 }}</span>
                <span class="text-sm text-muted">Failed</span>
              </span>
            </div>

            <p v-if="overview.downloads.active.length === 0" class="px-5 py-6 text-sm text-muted">
              Nothing downloading right now.
            </p>
            <div v-else class="divide-y divide-default">
              <div v-for="d in overview.downloads.active" :key="d.id" class="px-5 py-4">
                <div class="flex items-center justify-between gap-4">
                  <p class="truncate text-sm font-medium text-default" :title="d.filename">
                    {{ d.filename }}
                  </p>
                  <p class="shrink-0 text-xs text-muted">
                    from <span class="text-toned">{{ d.peerName }}</span>
                  </p>
                </div>
                <div class="mt-2.5 flex items-center gap-3">
                  <ProgressBar :value="d.progress" />
                  <span class="w-28 shrink-0 text-right text-xs tabular-nums text-muted">
                    {{ formatBytes(d.downloadedBytes) }} / {{ formatBytes(d.totalBytes) }}
                  </span>
                </div>
              </div>
            </div>
          </UCard>
        </section>

        <!-- Standing inventory: what this node is connected to. -->
        <section>
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Connections
          </h2>
          <div class="grid gap-4 md:grid-cols-2">
            <!-- Friends -->
            <UCard variant="subtle" :ui="{ body: '!p-0' }">
              <div class="flex items-center justify-between border-b border-default px-4 py-3">
                <span class="text-xs font-semibold uppercase tracking-wide text-muted">Friends online</span>
                <span class="text-xs tabular-nums text-dimmed">
                  {{ overview.peers.initialized }} of {{ overview.peers.total }}
                </span>
              </div>
              <div v-if="overview.peers.total === 0" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <p class="text-sm text-muted">
                  No friends yet.
                </p>
                <UButton :to="settingsLink('peers')" label="Add a friend" icon="i-ph-plus" size="sm" variant="soft" />
              </div>
              <div v-else class="divide-y divide-default">
                <div v-for="peer in overview.peers.items" :key="peer.id" class="flex items-center gap-3 px-4 py-2.5">
                  <ConnDot :initialized="peer.initialized" :error="peer.initializationError" :accent-class="peerTextClass(peer.id)" />
                  <span class="min-w-0 flex-1 truncate text-sm text-default" :title="peer.name">{{ peer.name }}</span>
                  <span v-if="peer.initialized" class="text-xs tabular-nums text-muted">{{ peer.version ?? '—' }}</span>
                  <span v-else-if="peer.initializationError" class="text-xs text-error">unreachable</span>
                  <span v-else class="text-xs text-muted">connecting…</span>
                </div>
              </div>
            </UCard>

            <!-- Radarr & Sonarr -->
            <UCard variant="subtle" :ui="{ body: '!p-0' }">
              <div class="flex items-center justify-between border-b border-default px-4 py-3">
                <span class="text-xs font-semibold uppercase tracking-wide text-muted">Radarr & Sonarr</span>
                <span class="text-xs tabular-nums text-dimmed">
                  {{ overview.servers.initialized }} of {{ overview.servers.total }} connected
                </span>
              </div>
              <div v-if="overview.servers.total === 0" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <p class="text-sm text-muted">
                  No Radarr or Sonarr yet.
                </p>
                <UButton :to="settingsLink('servers')" label="Connect Radarr or Sonarr" icon="i-ph-plus" size="sm" variant="soft" />
              </div>
              <div v-else class="divide-y divide-default">
                <div v-for="server in overview.servers.items" :key="server.id" class="flex items-center gap-3 px-4 py-2.5">
                  <ConnDot :initialized="server.initialized" :error="server.initializationError" />
                  <span class="min-w-0 flex-1 truncate text-sm text-default" :title="server.name">{{ server.name }}</span>
                  <span v-if="server.initialized" class="text-right text-xs text-muted">{{ serverRoleLabel(server) }}</span>
                  <span v-else-if="server.initializationError" class="text-xs text-error">unreachable</span>
                  <span v-else class="text-xs text-muted">connecting…</span>
                </div>
              </div>
            </UCard>
          </div>
        </section>
      </div>

      <p v-else class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>
    </template>
  </UDashboardPanel>
</template>
