<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { BandwidthConfig, BandwidthPeriod, TransferDirectionSummary, TransferInfo, Weekday } from '~/types/management'
import type { TransfersWithPause } from '~/types/tools'

const { request } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('transfers', () =>
  request<TransfersWithPause>('transfers'))

const { connected, hasConnectedOnce } = useManagementStream<TransfersWithPause>('transfers/stream', (snapshot) => {
  data.value = snapshot
  error.value = undefined
})

// The snapshot only carries the index of the schedule period in force; the period
// itself (days and times) comes from the bandwidth config. Fetched again when the
// period changes, so an edited schedule shows its new times.
const { data: bandwidth, status: bandwidthStatus, refresh: refreshBandwidth } = useLazyAsyncData(
  'transfers-bandwidth',
  () => request<BandwidthConfig | null>('config/bandwidth'),
)
watch(() => data.value?.schedulePeriod, (next, prev) => {
  if (next != null && next !== prev)
    void refreshBandwidth()
})

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const dayLabel = (day: Weekday) => day.charAt(0).toUpperCase() + day.slice(1)

// "Mon to Fri" for a run of three or more days, otherwise the days listed; nothing
// when the period covers the whole week.
function periodDays(days: Weekday[]): string {
  const sorted = WEEKDAYS.filter(d => days.includes(d))
  if (sorted.length === WEEKDAYS.length)
    return ''
  const first = WEEKDAYS.indexOf(sorted[0]!)
  const contiguous = sorted.every((d, i) => WEEKDAYS.indexOf(d) === first + i)
  if (contiguous && sorted.length >= 3)
    return `${dayLabel(sorted[0]!)} to ${dayLabel(sorted.at(-1)!)}`
  return sorted.map(dayLabel).join(', ')
}

function periodLabel(period: BandwidthPeriod): string {
  const time = period.start === period.end ? 'all day' : `${period.start} to ${period.end}`
  const days = periodDays(period.days)
  return days ? `${time} · ${days}` : time
}

// Named by its time range; the number only when the config can't be read. Nothing
// while the config is still loading, so the number doesn't flash first.
const scheduleLabel = computed(() => {
  const index = data.value?.schedulePeriod
  if (index == null)
    return null
  const period = bandwidth.value?.schedule[index]
  if (period)
    return periodLabel(period)
  if (bandwidthStatus.value === 'pending' || bandwidthStatus.value === 'idle')
    return null
  return `period ${index + 1}`
})

const directionMeta = {
  download: { label: 'Download', icon: 'i-ph-arrow-down', color: 'text-primary' },
  upload: { label: 'Upload', icon: 'i-ph-arrow-up', color: 'text-success' },
} as const

function summaryHint(summary: TransferDirectionSummary): string {
  const limit = summary.limitBytesPerSecond == null ? 'no limit' : `limit ${formatRate(summary.limitBytesPerSecond)}`
  const slots = summary.maxConcurrent == null ? `${summary.active} active` : `${summary.active} of ${summary.maxConcurrent} slots`
  return `${slots} · ${limit}`
}

function progressOf(transfer: TransferInfo): number | null {
  if (!transfer.totalBytes)
    return null
  return Math.min(1, transfer.transferredBytes / transfer.totalBytes)
}

// Downloads first, then uploads; fastest first within each.
const transfers = computed(() =>
  [...(data.value?.transfers ?? [])].sort((a, b) =>
    a.direction === b.direction ? b.bytesPerSecond - a.bytesPerSecond : a.direction === 'download' ? -1 : 1))

const columns: TableColumn<TransferInfo>[] = [
  { accessorKey: 'filename', header: 'File' },
  { accessorKey: 'peer', header: 'Friend' },
  { accessorKey: 'progress', header: 'Progress' },
  { accessorKey: 'transferredBytes', header: 'Transferred' },
  { accessorKey: 'bytesPerSecond', header: 'Speed' },
  { accessorKey: 'etaSeconds', header: 'Time left' },
]
</script>

<template>
  <UDashboardPanel id="transfers">
    <template #header>
      <UDashboardNavbar title="Live traffic">
        <template #right>
          <LiveBadge :connected="connected" :has-connected-once="hasConnectedOnce" />
        </template>
      </UDashboardNavbar>
      <!-- Pause sharing and downloads. Wraps on a narrow screen; a jack that
           doesn't report pauses gets no toolbar. -->
      <UDashboardToolbar v-if="data?.paused" :ui="{ root: 'flex-wrap overflow-x-visible py-2', left: 'min-w-0 flex-wrap gap-x-6 gap-y-2' }">
        <template #left>
          <PauseControls what="uploads" />
          <PauseControls what="downloads" />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <!-- Once a snapshot has arrived (from the request or the stream), keep showing it. -->
      <LoadErrorAlert v-if="error && !data" :error="error" :retry="refresh" />

      <p v-else-if="pending && !data" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <div v-else-if="data" class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Downloading from friends"
            :value="formatRate(data.download.bytesPerSecond)"
            :hint="summaryHint(data.download)"
            icon="i-ph-arrow-down"
          />
          <StatCard
            label="Uploading to friends"
            :value="formatRate(data.upload.bytesPerSecond)"
            :hint="summaryHint(data.upload)"
            icon="i-ph-arrow-up"
          />
        </div>

        <p v-if="scheduleLabel" class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          <UIcon name="i-ph-calendar-check" class="size-4 shrink-0" />
          <span>Bandwidth schedule in force: {{ scheduleLabel }}.</span>
          <ULink :to="settingsLink('bandwidth')" class="underline">
            Edit schedule
          </ULink>
        </p>

        <UCard v-if="transfers.length === 0" variant="subtle">
          <div class="flex flex-col items-center gap-3 py-6 text-center">
            <UIcon name="i-ph-arrows-down-up" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">
              Nothing is moving right now. Downloads from friends and uploads to them show up here while they run.
            </p>
          </div>
        </UCard>

        <template v-else>
          <!-- Desktop: the full table. -->
          <UCard class="hidden lg:block" variant="subtle" :ui="{ body: '!p-0' }">
            <UTable :data="transfers" :columns="columns" :ui="{ td: 'align-top' }">
              <template #filename-cell="{ row }">
                <div class="flex items-start gap-2">
                  <UIcon
                    :name="directionMeta[row.original.direction].icon"
                    class="mt-0.5 size-4 shrink-0" :class="[directionMeta[row.original.direction].color]"
                    :title="directionMeta[row.original.direction].label"
                  />
                  <p class="font-medium text-default" :title="row.original.filename">
                    {{ row.original.filename }}
                  </p>
                </div>
              </template>

              <template #peer-cell="{ row }">
                <span class="text-muted">{{ row.original.peer }}</span>
              </template>

              <template #progress-cell="{ row }">
                <div class="w-44">
                  <ProgressBar :value="progressOf(row.original)" />
                </div>
              </template>

              <template #transferredBytes-cell="{ row }">
                <span class="tabular-nums text-muted">
                  {{ formatBytes(row.original.transferredBytes) }} / {{ formatBytes(row.original.totalBytes) }}
                </span>
              </template>

              <template #bytesPerSecond-cell="{ row }">
                <span class="tabular-nums text-default">{{ formatRate(row.original.bytesPerSecond) }}</span>
              </template>

              <template #etaSeconds-cell="{ row }">
                <span class="tabular-nums text-muted">{{ formatEta(row.original.etaSeconds) }}</span>
              </template>
            </UTable>
          </UCard>

          <!-- Mobile: a card per transfer. -->
          <div class="space-y-2 lg:hidden">
            <UCard v-for="t in transfers" :key="t.id" variant="subtle" :ui="{ body: 'p-3' }">
              <div class="space-y-2.5">
                <div class="flex items-start gap-2">
                  <UIcon :name="directionMeta[t.direction].icon" class="mt-0.5 size-4 shrink-0" :class="[directionMeta[t.direction].color]" />
                  <p class="min-w-0 font-medium break-words text-default" :title="t.filename">
                    {{ t.filename }}
                  </p>
                </div>
                <ProgressBar :value="progressOf(t)" />
                <div class="flex items-center justify-between gap-2 text-xs text-muted">
                  <span class="truncate">{{ t.peer }}</span>
                  <span class="shrink-0 tabular-nums">
                    {{ formatRate(t.bytesPerSecond) }} · {{ formatEta(t.etaSeconds) }} left
                  </span>
                </div>
              </div>
            </UCard>
          </div>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
