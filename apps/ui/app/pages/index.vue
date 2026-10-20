<script setup lang="ts">
import type { ActivityDownload, ActivityOverview, ActivityTransfer, ActivityTransfersSnapshot, OverviewPeer } from '~/types/activity'

// The shared overview: the layout keeps its stream open on every page. While
// `jackDown` (the layout's "jack isn't answering"), the dashboard stops presenting
// its last snapshot as current: no all-clear, and the live sections say they show
// what jack last sent. It is the same app-wide state as that notice's, counted
// from the layout's mount on, so opening the dashboard during an outage or after
// a hidden tab neither restarts the count nor misses it.
const { overview: sharedOverview, error, refresh, connected, hasConnectedOnce, jackDown, whenLoaded } = useOverview()
// With the fields the management API added for this page (types/activity.ts).
const overview = computed(() => sharedOverview.value as ActivityOverview | undefined)

// Setup checklist state. Awaited together with the overview so the first render
// already knows whether setup is open: no card popping in, no green flash.
const setup = useSetupStatus(overview)
await Promise.all([whenLoaded(), setup.whenLoaded()])

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

// "seen 2 min ago" and "Checked 5 min ago" have to move on while nothing else
// changes, so they read a clock that ticks instead of the time of the last
// snapshot. Browsers slow timers down in background tabs, so coming back to the
// tab sets it at once.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
function tick() {
  now.value = Date.now()
}
function tickWhenShown() {
  if (document.visibilityState === 'visible')
    tick()
}
onMounted(() => {
  clock = setInterval(tick, 30_000)
  document.addEventListener('visibilitychange', tickWhenShown)
})
onBeforeUnmount(() => {
  clearInterval(clock)
  document.removeEventListener('visibilitychange', tickWhenShown)
})

// ── Right now ───────────────────────────────────────────────────────────────

// Speeds come from Live traffic's stream. It sends a snapshot when it opens, then
// one a second while anything moves.
const transfers = ref<ActivityTransfersSnapshot | null>(null)
useManagementStream<ActivityTransfersSnapshot>('transfers/stream', (snapshot) => {
  transfers.value = snapshot
})

const counts = computed(() => overview.value ? dashboardDownloadCounts(overview.value.downloads) : null)

// Friends with at least one upload from you running now.
const uploadFriends = computed(() =>
  new Set((transfers.value?.transfers ?? []).filter(t => t.direction === 'upload').map(t => t.peer)).size)

const downLine = computed(() => {
  const t = transfers.value
  const downloading = t?.download.active ?? counts.value?.downloading ?? 0
  return t ? `${formatRate(t.download.bytesPerSecond)} · ${downloading} downloading` : `${downloading} downloading`
})
const upLine = computed(() => {
  const t = transfers.value
  if (!t)
    return null
  const who = uploadFriends.value === 0
    ? 'nobody downloading from you'
    : `${uploadFriends.value} ${uploadFriends.value === 1 ? 'friend' : 'friends'} downloading from you`
  return `${formatRate(t.upload.bytesPerSecond)} · ${who}`
})
const pausedNote = computed(() => {
  const paused = transfers.value?.paused
  if (paused?.downloads.paused && paused.uploads.paused)
    return 'Downloads and sharing are paused.'
  if (paused?.downloads.paused)
    return 'Downloads are paused.'
  if (paused?.uploads.paused)
    return 'Sharing is paused.'
  return null
})

const transferByDownload = computed(() => {
  const map = new Map<number, ActivityTransfer>()
  for (const transfer of transfers.value?.transfers ?? []) {
    if (transfer.direction === 'download' && transfer.downloadId != null)
      map.set(transfer.downloadId, transfer)
  }
  return map
})

// The running downloads, moving ones first. A long queue is cut short here; the
// Downloads page has all of them.
const RUNNING_PREVIEW = 5
const running = computed(() => sortRunningDownloads(overview.value?.downloads.active ?? []))
const runningShown = computed(() => running.value.slice(0, RUNNING_PREVIEW))

function rowDetail(download: ActivityDownload): { text: string, tone: 'muted' | 'warning' } {
  const transfer = transferByDownload.value.get(download.id)
  if (transfer) {
    const rate = formatRate(transfer.bytesPerSecond)
    return { text: transfer.etaSeconds == null ? rate : `${rate} · ${formatEta(transfer.etaSeconds)} left`, tone: 'muted' }
  }
  const state = downloadState(download, { downloadsPaused: transfers.value?.paused?.downloads.paused ?? false })
  if (state.label !== 'Downloading')
    return { text: state.label, tone: state.color === 'warning' ? 'warning' : 'muted' }
  return { text: `${formatBytes(download.downloadedBytes)} / ${formatBytes(download.totalBytes)}`, tone: 'muted' }
}

// ── Friends ─────────────────────────────────────────────────────────────────

function friendRow(peer: OverviewPeer) {
  // A jack without health checks (older backend) falls back to the connector state.
  const health = peer.health ?? { online: peer.initialized ? true : (peer.initializationError ? false : null), offlineSince: null, lastSeenAt: null, lastError: peer.initializationError, lastErrorCode: null, checkedAt: null }
  const status = friendStatusWords(health, now.value)
  const seen = health.online === true && health.lastSeenAt ? `seen ${formatTimeAgo(health.lastSeenAt, now.value)}` : null
  return { status, seen, online: health.online, error: health.online === false ? (health.lastError ?? status.label) : null }
}

const STATUS_CLASS = {
  success: 'text-muted',
  neutral: 'text-muted',
  warning: 'text-warning',
  error: 'text-error',
} as const

// ── Lifetime ────────────────────────────────────────────────────────────────

// Hidden until something moved. The traffic counts start on the day `since` names;
// a jack that sends no lifetime block falls back to the download rows' bytes.
const lifetime = computed(() => {
  const o = overview.value
  if (!o)
    return null
  const downloaded = o.lifetime?.since ? o.lifetime.downloadedBytes : o.downloads.bytesMoved
  const uploaded = o.lifetime?.uploadedBytes ?? 0
  if (downloaded === 0 && uploaded === 0 && o.downloads.total === 0)
    return null
  return {
    downloaded,
    uploaded,
    since: formatCalendarDay(o.lifetime?.since),
    imported: o.downloads.byStatus.imported ?? 0,
    started: o.downloads.total,
  }
})
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
      <div v-else-if="overview && counts && (setup.settled || shownOnce)" class="space-y-8">
        <!-- What needs doing, first: setup, then problems. -->
        <div class="space-y-4">
          <SetupChecklist :status="setup" :now="now" :stale="jackDown" />
          <DashboardAttention
            :overview="overview"
            :setup-state="setup.requiredState"
            :downloads-on="setup.ready ? setup.downloadsOn : null"
            :share-only="setup.shareOnly"
            :setup-server-ids="setup.cardServerIds"
            :setup-asks-for-receiver="setup.cardAsksForReceiver"
            :setup-shows-problem="setup.cardShowsProblem"
            :now="now"
            :stale="jackDown"
          />
        </div>

        <!-- What is moving now, both ways. While jack isn't answering, it says it
             shows what jack last sent, and loses its colors. Text keeps its
             contrast, so the last values stay readable. -->
        <section class="transition-[filter]" :class="{ grayscale: jackDown }">
          <div class="mb-3 flex items-center justify-between gap-2">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-muted">
              {{ jackDown ? 'Last known' : 'Right now' }}
            </h2>
            <UButton to="/downloads" label="All downloads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="px-0" />
          </div>

          <UCard variant="subtle" :ui="{ body: '!p-0' }">
            <!-- Speeds both ways, to Live traffic. -->
            <NuxtLink
              to="/transfers"
              class="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-b border-default px-5 py-3.5 text-sm transition-colors hover:bg-elevated/50"
            >
              <span class="flex items-center gap-1.5 tabular-nums text-default">
                <UIcon name="i-ph-arrow-down" class="size-4 shrink-0 text-primary" />
                <span class="sr-only">Downloading:</span>
                {{ downLine }}
              </span>
              <span v-if="upLine" class="flex items-center gap-1.5 tabular-nums text-default">
                <UIcon name="i-ph-arrow-up" class="size-4 shrink-0 text-success" />
                <span class="sr-only">Uploading:</span>
                {{ upLine }}
              </span>
              <span v-if="pausedNote" class="flex items-center gap-1.5 text-warning">
                <UIcon name="i-ph-pause-circle" class="size-4 shrink-0" />
                {{ pausedNote }}
              </span>
              <UIcon name="i-ph-caret-right" class="ml-auto hidden size-4 shrink-0 text-dimmed sm:block" />
            </NuxtLink>

            <!-- Counts, each to its filter on Downloads. -->
            <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-default px-5 py-3.5">
              <NuxtLink to="/downloads?status=downloading" class="flex items-baseline gap-2 hover:underline">
                <span class="text-xl font-semibold tabular-nums text-primary">{{ counts.downloading }}</span>
                <span class="text-sm text-muted">Downloading</span>
              </NuxtLink>
              <NuxtLink to="/downloads?status=downloading" class="flex items-baseline gap-2 hover:underline">
                <span class="text-xl font-semibold tabular-nums text-toned">{{ counts.waiting }}</span>
                <span class="text-sm text-muted">Waiting</span>
              </NuxtLink>
              <NuxtLink v-if="counts.importQueued" to="/downloads?status=import_queued" class="flex items-baseline gap-2 hover:underline">
                <span class="text-xl font-semibold tabular-nums text-warning">{{ counts.importQueued }}</span>
                <span class="text-sm text-muted">Import queued</span>
              </NuxtLink>
              <NuxtLink to="/downloads?status=failed" class="flex items-baseline gap-2 hover:underline">
                <span class="text-xl font-semibold tabular-nums" :class="counts.failed ? 'text-error' : 'text-toned'">{{ counts.failed }}</span>
                <span class="text-sm text-muted">Failed</span>
              </NuxtLink>
            </div>

            <p v-if="running.length === 0" class="px-5 py-5 text-sm text-muted">
              Nothing downloading right now.
            </p>
            <div v-else class="divide-y divide-default">
              <div v-for="d in runningShown" :key="d.id" class="px-5 py-3.5">
                <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                  <p class="min-w-0 flex-1 truncate text-sm font-medium text-default" :title="d.filename">
                    {{ d.filename }}
                  </p>
                  <p class="shrink-0 text-xs text-muted">
                    from <span class="text-toned">{{ d.peerName }}</span>
                  </p>
                </div>
                <div class="mt-2 flex items-center gap-3">
                  <div class="min-w-0 flex-1">
                    <ProgressBar :value="d.progress" />
                  </div>
                  <span
                    class="max-w-[45%] shrink-0 truncate text-right text-xs tabular-nums"
                    :class="rowDetail(d).tone === 'warning' ? 'text-warning' : 'text-muted'"
                  >
                    {{ rowDetail(d).text }}
                  </span>
                </div>
              </div>
              <NuxtLink
                v-if="running.length > RUNNING_PREVIEW"
                to="/downloads?status=downloading"
                class="block px-5 py-3 text-xs text-muted hover:text-default"
              >
                and {{ running.length - RUNNING_PREVIEW }} more
              </NuxtLink>
            </div>
          </UCard>
        </section>

        <!-- Standing inventory: who and what this jack works with. Its online and
             connected states are live, so it is marked with the section above. -->
        <section class="transition-[filter]" :class="{ grayscale: jackDown }">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Friends & Radarr/Sonarr<span v-if="jackDown" class="font-normal normal-case tracking-normal"> · last known</span>
          </h2>
          <div class="grid gap-4 md:grid-cols-2">
            <!-- Friends -->
            <UCard variant="subtle" :ui="{ body: '!p-0' }">
              <div class="flex items-center justify-between border-b border-default px-4 py-3">
                <NuxtLink to="/friends" class="text-xs font-semibold uppercase tracking-wide text-muted hover:text-default">
                  Friends online
                </NuxtLink>
                <span class="text-xs tabular-nums text-dimmed">
                  {{ overview.peers.online ?? overview.peers.initialized }} of {{ overview.peers.total }}
                </span>
              </div>
              <div v-if="overview.peers.total === 0" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <p class="text-sm text-muted">
                  No friends yet.
                </p>
                <UButton to="/friends?action=add" label="Add a friend" icon="i-ph-plus" size="sm" variant="soft" />
              </div>
              <div v-else class="divide-y divide-default">
                <div v-for="peer in overview.peers.items" :key="peer.id" class="flex items-center gap-3 px-4 py-2.5">
                  <ConnDot
                    :initialized="friendRow(peer).online === true"
                    :error="friendRow(peer).error"
                    :accent-class="peerTextClass(peer.id)"
                  />
                  <span class="min-w-0 flex-1 truncate text-sm text-default" :title="peer.name">{{ peer.name }}</span>
                  <span
                    v-if="friendRow(peer).seen"
                    class="shrink-0 text-xs text-muted"
                    :title="formatDate(peer.health?.lastSeenAt)"
                  >
                    <span class="sr-only">Online, </span>{{ friendRow(peer).seen }}
                  </span>
                  <span
                    v-else
                    class="shrink-0 text-right text-xs"
                    :class="STATUS_CLASS[friendRow(peer).status.tone]"
                    :title="peer.health?.lastError ?? undefined"
                  >
                    {{ friendRow(peer).status.label }}
                  </span>
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
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-default" :title="server.name">{{ server.name }}</span>
                    <!-- Set when this *arr last used the key jack gave it (Torznab or its download client). -->
                    <span
                      v-if="server.lastContactAt"
                      class="block truncate text-xs text-muted"
                      :title="formatDate(server.lastContactAt)"
                    >last reached jack {{ formatTimeAgo(server.lastContactAt, now) }}</span>
                    <!-- The attention card above says what it means. -->
                    <span
                      v-if="server.initialized && indexerPause(server.registration, now)"
                      class="block truncate text-xs text-warning"
                    >skips jack's indexer for now</span>
                  </span>
                  <span v-if="server.initialized" class="text-right text-xs text-muted">{{ serverRoleLabel(server) }}</span>
                  <span v-else-if="server.initializationError" class="text-xs text-error">unreachable</span>
                  <span v-else class="text-xs text-muted">connecting…</span>
                </div>
              </div>
            </UCard>
          </div>
        </section>

        <!-- Lifetime totals, once anything moved. -->
        <section v-if="lifetime">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Lifetime<span v-if="lifetime.since" class="font-normal normal-case tracking-normal"> · since {{ lifetime.since }}</span>
          </h2>
          <UCard variant="subtle" :ui="{ body: 'flex flex-wrap gap-x-8 gap-y-3 !py-4' }">
            <p class="flex items-baseline gap-2">
              <span class="text-lg font-semibold tabular-nums text-highlighted">{{ formatBytes(lifetime.downloaded) }}</span>
              <span class="text-sm text-muted">Downloaded from friends</span>
            </p>
            <p class="flex items-baseline gap-2">
              <span class="text-lg font-semibold tabular-nums text-highlighted">{{ formatBytes(lifetime.uploaded) }}</span>
              <span class="text-sm text-muted">Shared with friends</span>
            </p>
            <p class="flex items-baseline gap-2">
              <span class="text-lg font-semibold tabular-nums text-highlighted">{{ lifetime.imported }}</span>
              <span class="text-sm text-muted">Imported</span>
            </p>
            <p class="flex items-baseline gap-2">
              <span class="text-lg font-semibold tabular-nums text-highlighted">{{ lifetime.started }}</span>
              <span class="text-sm text-muted">Downloads started</span>
            </p>
          </UCard>
        </section>
      </div>

      <p v-else class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>
    </template>
  </UDashboardPanel>
</template>
