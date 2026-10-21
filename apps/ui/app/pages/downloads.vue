<script setup lang="ts">
import type { BadgeProps, TableColumn } from '@nuxt/ui'
import type { ActivityDownload, ActivityTransfer, ActivityTransfersSnapshot } from '~/types/activity'
import type { DownloadAction, DownloadFilter, DownloadState } from '~/utils/download-actions'

const { request, extractError, errorInfo } = useManagement()
const toast = useToast()
const route = useRoute()
const router = useRouter()

const { data, pending, error, refresh } = await useAsyncData('downloads', () =>
  request<{ downloads: ActivityDownload[] }>('downloads'))

const { connected, hasConnectedOnce } = useManagementStream<{ downloads: ActivityDownload[] }>('downloads/stream', (snapshot) => {
  data.value = snapshot
  error.value = undefined
})

// Only words the empty state, so it names the next step that leads to a download:
// downloads on, after the restart they may wait for, a Radarr/Sonarr that
// receives downloads, and a friend to download from.
const { data: downloadsConfig, status: downloadsConfigStatus, refresh: refreshDownloadsConfig } = useDownloadsConfig()
const { overview, error: overviewError } = useOverview()
const emptyState = computed(() => downloadsEmptyState({
  downloadsConfig: downloadsConfig.value,
  downloadsConfigFailed: downloadsConfigStatus.value === 'error',
  overview: overview.value,
  overviewFailed: overviewError.value !== undefined,
}))

// While jack is unreachable both loads fail, so a retry repeats both. The config
// only when it is missing: a failed refetch would throw away an answer it has.
async function retryLoad() {
  await Promise.all([
    refresh(),
    downloadsConfig.value === undefined ? refreshDownloadsConfig() : undefined,
  ])
}

// ── Filter ──────────────────────────────────────────────────────────────────

// The chip in force lives in the address (`?status=failed`), so the Dashboard can
// link straight to it and Back returns to it. Active is the default and has no query.
const filter = ref<DownloadFilter>(parseDownloadFilter(route.query.status) ?? 'active')
watch(() => route.query.status, (status) => {
  filter.value = parseDownloadFilter(status) ?? 'active'
})
function setFilter(next: DownloadFilter) {
  filter.value = next
  const status = next === 'active' ? undefined : next
  if (route.query.status !== status)
    void router.replace({ query: { ...route.query, status } })
}

const downloads = computed(() => data.value?.downloads ?? [])
const counts = computed(() => Object.fromEntries(DOWNLOAD_FILTERS.map(f =>
  [f, downloads.value.filter(d => matchesDownloadFilter(d, f)).length])) as Record<DownloadFilter, number>)

const CHIPS: Array<{ key: DownloadFilter, label: string, color: BadgeProps['color'] }> = [
  { key: 'active', label: 'Active', color: 'primary' },
  { key: 'downloading', label: 'Downloading', color: 'primary' },
  { key: 'waiting', label: 'Waiting', color: 'neutral' },
  { key: 'import_queued', label: 'Import queued', color: 'warning' },
  { key: 'failed', label: 'Failed', color: 'error' },
  { key: 'cancelled', label: 'Cancelled', color: 'neutral' },
  { key: 'imported', label: 'Imported', color: 'success' },
  { key: 'all', label: 'All', color: 'neutral' },
]
// Cancelled shows up only when there is something to show, or it was asked for.
const chips = computed(() => CHIPS.filter(chip => chip.key !== 'cancelled' || counts.value.cancelled > 0 || filter.value === 'cancelled'))

const EMPTY_FILTER: Record<DownloadFilter, string> = {
  active: 'Nothing is downloading, waiting for import or failed.',
  downloading: 'Nothing is downloading.',
  waiting: 'Nothing is waiting for a free slot or to retry.',
  import_queued: 'Nothing is waiting for Radarr/Sonarr to import it.',
  failed: 'No failed downloads.',
  cancelled: 'No cancelled downloads.',
  imported: 'Nothing imported yet.',
  all: 'No downloads.',
}

const filtered = computed(() => downloads.value.filter(d => matchesDownloadFilter(d, filter.value)))

// Client-side pagination: just slice the filtered list. No server round-trips.
const PAGE_SIZE = 10
const page = ref(1)
const total = computed(() => filtered.value.length)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const showingFrom = computed(() => (total.value === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1))
const showingTo = computed(() => Math.min(page.value * PAGE_SIZE, total.value))

// Switching filters starts over at page one; a refresh that shrinks the list
// clamps the current page so we never strand the user on an empty page.
watch(filter, () => {
  page.value = 1
})
watch(pageCount, (count) => {
  if (page.value > count)
    page.value = count
})

// ── Speed and time left ─────────────────────────────────────────────────────

// Live traffic's snapshot carries speed and time left per transfer, and whether
// downloads are paused. Its stream sends one every second while anything moves, so
// it is open only while this page shows a running download.
const transfers = ref<ActivityTransfersSnapshot | null>(null)
const showsRunning = computed(() => paged.value.some(d => d.status === 'downloading'))
let stopTransfers: (() => void) | undefined
// Counts snapshots and closes, so a fetch that answers after either is dropped.
let transfersRevision = 0
async function loadTransfers() {
  const revision = transfersRevision
  try {
    const snapshot = await request<ActivityTransfersSnapshot>('transfers')
    if (revision === transfersRevision)
      transfers.value = snapshot
  }
  catch {}
}
function followTransfers(on: boolean) {
  if (on && !stopTransfers) {
    stopTransfers = subscribeManagementStream<ActivityTransfersSnapshot>('transfers/stream', {
      onSnapshot: (snapshot) => {
        transfersRevision++
        transfers.value = snapshot
      },
      // A connection another page opened (Dashboard, Live traffic) is reused and
      // sends no first snapshot. jack sends the next one only when something
      // changes, which may not happen while downloads are paused, so fetch it.
      onOpen: () => void loadTransfers(),
    }, async () => {
      await request('ping')
    })
  }
  else if (!on && stopTransfers) {
    stopTransfers()
    stopTransfers = undefined
    transfersRevision++
    transfers.value = null
  }
}
watch(showsRunning, followTransfers)
onMounted(() => followTransfers(showsRunning.value))
onBeforeUnmount(() => followTransfers(false))

const transferByDownload = computed(() => {
  const map = new Map<number, ActivityTransfer>()
  for (const transfer of transfers.value?.transfers ?? []) {
    if (transfer.direction === 'download' && transfer.downloadId != null)
      map.set(transfer.downloadId, transfer)
  }
  return map
})
const downloadsPaused = computed(() => transfers.value?.paused?.downloads.paused ?? false)

function stateOf(download: ActivityDownload): DownloadState {
  return downloadState(download, { downloadsPaused: downloadsPaused.value })
}

// "12.0 MB/s · 4m 10s left" for a download that is moving right now.
function speedLine(download: ActivityDownload): string | null {
  const transfer = download.status === 'downloading' ? transferByDownload.value.get(download.id) : undefined
  if (!transfer)
    return null
  return transfer.etaSeconds == null
    ? formatRate(transfer.bytesPerSecond)
    : `${formatRate(transfer.bytesPerSecond)} · ${formatEta(transfer.etaSeconds)} left`
}

const NOTE_CLASS: Record<DownloadState['noteTone'], string> = {
  error: 'text-error',
  warning: 'text-warning',
  muted: 'text-muted',
}

// ── Actions ─────────────────────────────────────────────────────────────────

const pendingActions = ref<Record<number, DownloadAction | undefined>>({})

const ACTION_COPY: Record<DownloadAction, { done: string, verb: string }> = {
  cancel: { done: 'Download cancelled', verb: 'cancel' },
  retry: { done: 'Retrying the download', verb: 'retry' },
  delete: { done: 'Download removed', verb: 'remove' },
}

async function runAction(download: ActivityDownload, action: DownloadAction) {
  if (pendingActions.value[download.id])
    return
  pendingActions.value[download.id] = action
  try {
    if (action === 'delete')
      await request<{ ok: true }>(`downloads/${download.id}`, { method: 'DELETE' })
    else
      await request<{ download: ActivityDownload }>(`downloads/${download.id}/${action}`, { method: 'POST' })
    toast.add({
      title: ACTION_COPY[action].done,
      description: action === 'cancel' ? 'Retry continues from the partial file.' : undefined,
      color: 'success',
    })
    await refresh()
  }
  catch (actionError) {
    toast.add({
      title: `Could not ${ACTION_COPY[action].verb} the download`,
      description: extractError(actionError),
      color: 'error',
    })
  }
  finally {
    delete pendingActions.value[download.id]
  }
}

// Cancel and Remove ask first, in the app's own dialog.
const confirming = ref<{ download: ActivityDownload, action: 'cancel' | 'delete' } | null>(null)
const CONFIRM_COPY = {
  cancel: {
    title: 'Cancel this download?',
    body: 'The partial file is kept so you can retry it later.',
    keep: 'Keep downloading',
    confirm: 'Cancel download',
  },
  delete: {
    title: 'Remove this download?',
    body: 'jack removes it from this list and deletes its own copy of the file, partial or finished. Anything Radarr/Sonarr already imported stays in your library.',
    keep: 'Keep',
    confirm: 'Remove',
  },
} as const

function onAction(download: ActivityDownload, action: DownloadAction) {
  if (action === 'retry')
    void runAction(download, action)
  else
    confirming.value = { download, action }
}

function confirmAction() {
  const target = confirming.value
  confirming.value = null
  if (target)
    void runAction(target.download, target.action)
}

// Retry now ends the wait of a row waiting to retry. The attempt still waits for
// a free slot, ahead of new downloads.
const retryingNow = ref<Record<number, boolean>>({})
// Set when jack turns out to be older than Retry now. The button stays away until
// jack restarts, which an update does.
const retryNowMissing = ref(false)
onJackBack(() => {
  retryNowMissing.value = false
})
function showsRetryNow(download: ActivityDownload): boolean {
  return !retryNowMissing.value && canRetryNow(download, { downloadsPaused: downloadsPaused.value })
}
async function retryNow(download: ActivityDownload) {
  if (retryingNow.value[download.id] || pendingActions.value[download.id])
    return
  retryingNow.value[download.id] = true
  try {
    await request<{ download: ActivityDownload }>(`downloads/${download.id}/retry-now`, { method: 'POST' })
    toast.add({ title: 'Retrying the download', description: 'It starts as soon as a download slot is free.', color: 'success' })
    await refresh()
  }
  catch (retryError) {
    switch (retryNowFailure(errorInfo(retryError))) {
      case 'stale':
        toast.add({ title: 'This download isn\'t waiting to retry any more', color: 'neutral' })
        await refresh()
        break
      case 'unsupported':
        retryNowMissing.value = true
        toast.add({
          title: 'Retry now needs a newer jack',
          description: 'Update the jack container in Unraid\'s Docker tab. Until then, the download retries by itself at the time shown.',
          color: 'neutral',
        })
        break
      default:
        toast.add({ title: 'Could not retry the download now', description: extractError(retryError), color: 'error' })
    }
  }
  finally {
    delete retryingNow.value[download.id]
  }
}

// "Retry all failed" goes through the failures Retry can start, one at a time.
const retryable = computed(() => retryableFailures(downloads.value))
const showRetryAll = computed(() => (filter.value === 'failed' || filter.value === 'active') && retryable.value.length > 0)
const retryingAll = ref(false)
async function retryAllFailed() {
  const rows = retryable.value.filter(d => !pendingActions.value[d.id])
  if (retryingAll.value || rows.length === 0)
    return
  retryingAll.value = true
  let started = 0
  let firstError: string | null = null
  for (const download of rows) {
    pendingActions.value[download.id] = 'retry'
    try {
      await request(`downloads/${download.id}/retry`, { method: 'POST' })
      started++
    }
    catch (err) {
      firstError ??= extractError(err)
    }
    finally {
      delete pendingActions.value[download.id]
    }
  }
  retryingAll.value = false
  if (firstError === null)
    toast.add({ title: started === 1 ? 'Retrying 1 download' : `Retrying ${started} downloads`, color: 'success' })
  else
    toast.add({ title: `Retried ${started} of ${rows.length} downloads`, description: firstError, color: 'warning' })
  await refresh()
}

const columns: TableColumn<ActivityDownload>[] = [
  { accessorKey: 'filename', header: 'File' },
  { accessorKey: 'peerName', header: 'From' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'progress', header: 'Progress' },
  { accessorKey: 'totalBytes', header: 'Size' },
  { accessorKey: 'updatedAt', header: 'Updated' },
  { id: 'actions', header: '' },
]
</script>

<template>
  <UDashboardPanel id="downloads">
    <template #header>
      <UDashboardNavbar title="Downloads">
        <template #right>
          <LiveBadge :connected="connected" :has-connected-once="hasConnectedOnce" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <LoadErrorAlert v-if="error && !data" :error="error" :retry="retryLoad" />

      <p
        v-else-if="(pending && !data) || (data?.downloads.length === 0 && emptyState === 'loading')"
        class="flex items-center gap-2 text-sm text-muted"
      >
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <UCard v-else-if="data && data.downloads.length === 0" variant="subtle">
        <div v-if="emptyState === 'off'" class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
          <p class="max-w-md text-sm text-muted">
            Downloads are off, so Radarr/Sonarr can't start downloads from friends.
          </p>
          <UButton label="Turn on downloads" icon="i-ph-power" :to="settingsLink('downloads')" />
        </div>
        <div v-else-if="emptyState === 'restart'" class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-arrow-clockwise" class="size-8 text-dimmed" />
          <p class="max-w-md text-sm text-muted">
            Restart the jack container to start downloading.
          </p>
          <p class="max-w-md text-xs text-dimmed">
            Unraid: <span class="whitespace-nowrap">{{ RESTART_STEPS }}</span>. jack-ui doesn't need a restart.
          </p>
        </div>
        <div v-else-if="emptyState === 'no-server'" class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
          <p class="max-w-md text-sm text-muted">
            Nothing downloaded yet. Connect the Radarr or Sonarr that should receive friends' downloads.
          </p>
          <UButton label="Connect Radarr or Sonarr" icon="i-ph-plus" :to="settingsLink('servers')" />
        </div>
        <div v-else-if="emptyState === 'no-receiver'" class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
          <p class="max-w-md text-sm text-muted">
            Nothing downloaded yet. To get friends' movies and episodes, turn on Download from friends for a Radarr or Sonarr.
          </p>
          <UButton label="Open Radarr & Sonarr" icon="i-ph-gear-six" :to="settingsLink('servers')" />
        </div>
        <div v-else-if="emptyState === 'no-friend'" class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
          <p class="max-w-md text-sm text-muted">
            Nothing downloaded yet. Add a friend to download from their library.
          </p>
          <UButton label="Add a friend" icon="i-ph-user-plus" to="/friends?action=add" />
        </div>
        <div v-else class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
          <!-- The indexer is mentioned only where jack added one that works. -->
          <p class="max-w-md text-sm text-muted">
            <template v-if="emptyState === 'library-or-search'">
              Nothing downloaded yet. Pick something in Friends' library, or search in Radarr/Sonarr,
              where jack appears as an indexer.
            </template>
            <template v-else>
              Nothing downloaded yet. Pick something in Friends' library.
            </template>
          </p>
          <UButton label="Browse Friends' library" icon="i-ph-film-reel" to="/catalog" />
        </div>
      </UCard>

      <div v-else-if="data" class="space-y-4">
        <!-- While downloads are paused, waiting rows don't start: until when, and Resume. -->
        <PauseControls v-if="downloadsPaused" what="downloads" />

        <!-- Status filter / breakdown. Wraps on a phone. -->
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            v-for="chip in chips"
            :key="chip.key"
            :color="chip.color"
            :variant="filter === chip.key ? 'subtle' : 'ghost'"
            size="sm"
            :aria-pressed="filter === chip.key"
            @click="setFilter(chip.key)"
          >
            {{ chip.label }}
            <UBadge :color="chip.color" :variant="filter === chip.key ? 'solid' : 'soft'" size="sm">
              {{ counts[chip.key] }}
            </UBadge>
          </UButton>
          <UButton
            v-if="showRetryAll"
            :label="`Retry all failed (${retryable.length})`"
            icon="i-ph-arrow-clockwise"
            size="sm"
            variant="soft"
            class="sm:ml-auto"
            :loading="retryingAll"
            @click="retryAllFailed"
          />
        </div>

        <!-- Wide screens: the full table. Its seven columns fit from xl (1280 px) on,
             with room for a classic scrollbar: the cells use less padding, and the
             File and From cells wrap. Narrower screens get the cards below. -->
        <UCard class="hidden xl:block" variant="subtle" :ui="{ body: '!p-0' }">
          <UTable :data="paged" :columns="columns" :ui="{ th: 'px-3', td: 'align-top px-3' }">
            <!-- Table cells don't wrap, so the file cell opts back in and caps its
                 width: a long name or note wraps instead of pushing Size, Updated
                 and the actions off-screen. -->
            <template #filename-cell="{ row }">
              <div class="max-w-md min-w-48 whitespace-normal">
                <p class="font-medium wrap-anywhere text-default" :title="row.original.filename">
                  {{ row.original.filename }}
                </p>
                <p
                  v-if="stateOf(row.original).note"
                  class="text-xs wrap-anywhere"
                  :class="NOTE_CLASS[stateOf(row.original).noteTone]"
                  :title="row.original.error ?? undefined"
                >
                  {{ stateOf(row.original).note }}
                </p>
                <p v-else-if="row.original.expectedBytesMismatch" class="text-xs text-warning">
                  size mismatch
                </p>
              </div>
            </template>

            <!-- A friend's name wraps too, so "Christoffer (Odense)" takes two lines
                 instead of the row's actions. -->
            <template #peerName-cell="{ row }">
              <p class="max-w-28 whitespace-normal break-words text-muted">
                {{ row.original.peerName }}
              </p>
            </template>

            <template #status-cell="{ row }">
              <UBadge :color="stateOf(row.original).color" :label="stateOf(row.original).label" variant="subtle" />
            </template>

            <template #progress-cell="{ row }">
              <div class="w-44">
                <ProgressBar :value="row.original.progress" />
                <p v-if="speedLine(row.original)" class="mt-1 text-xs tabular-nums text-muted">
                  {{ speedLine(row.original) }}
                </p>
              </div>
            </template>

            <template #totalBytes-cell="{ row }">
              <span class="tabular-nums text-muted">{{ formatBytes(row.original.totalBytes) }}</span>
            </template>

            <template #updatedAt-cell="{ row }">
              <span class="text-xs tabular-nums text-muted" :title="formatDate(row.original.updatedAt)">
                {{ formatAgo(row.original.updatedAt) }} ago
              </span>
            </template>

            <template #actions-cell="{ row }">
              <div class="flex items-center justify-end gap-1">
                <UTooltip v-if="showsRetryNow(row.original)" text="Retry now">
                  <UButton
                    :aria-label="`Retry ${row.original.filename} now`"
                    icon="i-ph-arrow-clockwise"
                    color="primary"
                    variant="ghost"
                    size="sm"
                    :loading="retryingNow[row.original.id]"
                    :disabled="retryingNow[row.original.id] || pendingActions[row.original.id] !== undefined"
                    @click="retryNow(row.original)"
                  />
                </UTooltip>
                <DownloadActions
                  :download="row.original"
                  :pending="pendingActions[row.original.id]"
                  @action="onAction(row.original, $event)"
                />
              </div>
            </template>

            <template #empty>
              <div class="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted">
                {{ EMPTY_FILTER[filter] }}
                <UButton v-if="filter !== 'all'" label="Show all" color="neutral" variant="link" size="sm" @click="setFilter('all')" />
              </div>
            </template>
          </UTable>
        </UCard>

        <!-- Phones to small laptops: a card per download, since the table needs more width. -->
        <div class="space-y-2 xl:hidden">
          <UCard v-for="d in paged" :key="d.id" variant="subtle" :ui="{ body: 'p-3' }">
            <div class="space-y-2.5">
              <div class="min-w-0 space-y-1.5">
                <p class="font-medium break-words text-default" :title="d.filename">
                  {{ d.filename }}
                </p>
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <UBadge :color="stateOf(d).color" :label="stateOf(d).label" variant="subtle" />
                  <span class="min-w-0 truncate">from {{ d.peerName }}</span>
                </div>
                <template v-if="stateOf(d).note">
                  <p class="text-xs break-words" :class="NOTE_CLASS[stateOf(d).noteTone]" :title="d.error ?? undefined">
                    {{ stateOf(d).note }}
                  </p>
                  <!-- jack's own error text, which the note puts in plain words. Phones
                       have no hover for the tooltip, so it shows here. -->
                  <p v-if="stateOf(d).detail" class="font-mono text-xs break-words text-dimmed">
                    {{ stateOf(d).detail }}
                  </p>
                </template>
                <p v-else-if="d.expectedBytesMismatch" class="text-xs text-warning">
                  size mismatch
                </p>
              </div>
              <ProgressBar :value="d.progress" />
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="min-w-0 text-xs tabular-nums text-muted">
                  {{ formatBytes(d.totalBytes) }} · {{ speedLine(d) ?? `${formatAgo(d.updatedAt)} ago` }}
                </span>
                <div class="ml-auto flex flex-wrap items-center justify-end gap-1">
                  <UButton
                    v-if="showsRetryNow(d)"
                    label="Retry now"
                    icon="i-ph-arrow-clockwise"
                    color="primary"
                    variant="soft"
                    size="sm"
                    :loading="retryingNow[d.id]"
                    :disabled="retryingNow[d.id] || pendingActions[d.id] !== undefined"
                    @click="retryNow(d)"
                  />
                  <DownloadActions
                    :download="d"
                    :pending="pendingActions[d.id]"
                    labelled
                    @action="onAction(d, $event)"
                  />
                </div>
              </div>
            </div>
          </UCard>

          <div v-if="paged.length === 0" class="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted">
            {{ EMPTY_FILTER[filter] }}
            <UButton v-if="filter !== 'all'" label="Show all" color="neutral" variant="link" size="sm" @click="setFilter('all')" />
          </div>
        </div>

        <!-- Pagination shared by both layouts. -->
        <div v-if="total > 0" class="flex flex-wrap items-center justify-between gap-4">
          <p class="text-xs tabular-nums text-muted">
            Showing {{ showingFrom }}–{{ showingTo }} of {{ total }}
          </p>
          <UPagination
            v-if="pageCount > 1"
            v-model:page="page"
            :total="total"
            :items-per-page="PAGE_SIZE"
            :sibling-count="1"
            size="sm"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <UModal
    :open="confirming !== null"
    :title="confirming ? CONFIRM_COPY[confirming.action].title : ''"
    :ui="{ footer: 'justify-end' }"
    @update:open="(open: boolean) => { if (!open) confirming = null }"
  >
    <template #body>
      <div v-if="confirming" class="space-y-2">
        <p class="text-sm font-medium break-words text-default">
          {{ confirming.download.filename }}
        </p>
        <p class="text-sm text-muted">
          {{ CONFIRM_COPY[confirming.action].body }}
        </p>
      </div>
    </template>
    <template #footer>
      <UButton
        :label="confirming ? CONFIRM_COPY[confirming.action].keep : 'Keep'"
        color="neutral"
        variant="ghost"
        @click="confirming = null"
      />
      <UButton
        :label="confirming ? CONFIRM_COPY[confirming.action].confirm : 'Confirm'"
        color="error"
        @click="confirmAction"
      />
    </template>
  </UModal>
</template>
