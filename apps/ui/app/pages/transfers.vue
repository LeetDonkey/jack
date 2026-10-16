<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { TransferDirectionSummary, TransferInfo, TransfersSnapshot } from '~/types/management'

const { request } = useManagement()

const { data, pending, error } = await useAsyncData('transfers', () =>
  request<TransfersSnapshot>('transfers'))

const { connected } = useManagementStream<TransfersSnapshot>('transfers/stream', (snapshot) => {
  data.value = snapshot
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
  { accessorKey: 'peer', header: 'Peer' },
  { accessorKey: 'progress', header: 'Progress' },
  { accessorKey: 'transferredBytes', header: 'Transferred' },
  { accessorKey: 'bytesPerSecond', header: 'Speed' },
  { accessorKey: 'etaSeconds', header: 'Time left' },
]
</script>

<template>
  <UDashboardPanel id="transfers">
    <template #header>
      <UDashboardNavbar title="Transfers">
        <template #right>
          <UBadge :color="connected ? 'success' : 'warning'" variant="subtle" icon="i-ph-broadcast">
            {{ connected ? 'Live' : 'Reconnecting…' }}
          </UBadge>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load transfers." />

      <p v-else-if="pending && !data" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <div v-else-if="data" class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Downloading from peers"
            :value="formatRate(data.download.bytesPerSecond)"
            :hint="summaryHint(data.download)"
            icon="i-ph-arrow-down"
          />
          <StatCard
            label="Uploading to peers"
            :value="formatRate(data.upload.bytesPerSecond)"
            :hint="summaryHint(data.upload)"
            icon="i-ph-arrow-up"
          />
        </div>

        <p v-if="data.schedulePeriod != null" class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-ph-calendar-check" class="size-4" />
          Bandwidth schedule period {{ data.schedulePeriod + 1 }} is in force.
          <ULink to="/settings" class="underline">
            Edit schedule
          </ULink>
        </p>

        <UCard v-if="transfers.length === 0" variant="subtle">
          <div class="flex flex-col items-center gap-3 py-6 text-center">
            <UIcon name="i-ph-arrows-down-up" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">
              Nothing is moving right now. Downloads from peers and uploads to them show up here while they run.
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
