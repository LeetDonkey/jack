<script setup lang="ts">
import type { CheckStatus } from '~/types/tools'
import { folderSummary } from '~/utils/folder-check'

const { report, running, error, run } = useFolderCheck()

const STATUS_ICON: Record<CheckStatus, { icon: string, class: string }> = {
  ok: { icon: 'i-ph-check-circle', class: 'text-success' },
  error: { icon: 'i-ph-x-circle', class: 'text-error' },
  unknown: { icon: 'i-ph-warning-circle', class: 'text-warning' },
}

const TONE: Record<'ok' | 'warning' | 'error', { icon: string, class: string }> = {
  ok: STATUS_ICON.ok,
  error: STATUS_ICON.error,
  warning: STATUS_ICON.unknown,
}

const summary = computed(() => (report.value ? folderSummary(report.value) : null))

const checkedAt = computed(() => {
  const at = report.value ? new Date(report.value.checkedAt) : null
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : null
})

interface Line {
  status: CheckStatus
  text: string
}

interface Group {
  key: string
  title: string
  path?: string
  lines: Line[]
  note?: string
}

// Every check in the report, grouped as jack ran them.
const groups = computed<Group[]>(() => {
  const r = report.value
  if (!r)
    return []
  const out: Group[] = []
  if (r.completed) {
    const c = r.completed
    out.push({
      key: 'completed',
      title: 'Completed folder',
      path: c.path,
      note: c.freeBytes == null ? undefined : `${formatBytes(c.freeBytes)} free`,
      lines: [
        // The folder's own result, unless that only sums up the lines below.
        ...(c.destinations.some(d => d.status === 'error') ? [] : [{ status: c.status, text: c.message }]),
        ...c.destinations.map(d => ({ status: d.status, text: d.message })),
      ],
    })
  }
  for (const s of r.sources) {
    out.push({
      key: `source:${s.serverId}`,
      title: `${s.name}'s library`,
      lines: [
        ...(s.message ? [{ status: s.status, text: s.message }] : []),
        ...s.rootFolders.map(c => ({ status: c.status, text: c.message })),
        ...s.sampleFiles.map(c => ({ status: c.status, text: c.message })),
      ],
    })
  }
  return out
})

// Details open by themselves when something needs a look.
const detailsOpen = ref(false)
watch(report, (next) => {
  detailsOpen.value = Boolean(next && summary.value?.tone !== 'ok')
}, { immediate: true })
</script>

<template>
  <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-highlighted">
          Folder check
        </p>
        <p class="text-xs text-muted">
          Checks that jack sees each shared library where Radarr/Sonarr keep it, and that each
          Radarr/Sonarr that receives downloads sees the completed folder at the same path as jack.
          Uses the saved settings.
        </p>
      </div>
      <UButton
        label="Check folders"
        icon="i-ph-folders"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="running"
        @click="run"
      />
    </div>

    <p v-if="running && !report" class="flex items-center gap-2 text-xs text-muted">
      <UIcon name="i-ph-circle-notch" class="size-3.5 animate-spin" />
      Checking… this can take up to 30 seconds.
    </p>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <template v-if="report && summary">
      <div class="flex items-start gap-2 text-sm" :class="TONE[summary.tone].class">
        <UIcon :name="TONE[summary.tone].icon" class="mt-0.5 size-4 shrink-0" />
        <div class="min-w-0">
          <p class="break-words">
            {{ summary.text }}
          </p>
          <p v-if="checkedAt" class="text-xs text-muted">
            {{ running ? 'Checking again…' : `Checked at ${checkedAt}.` }}
          </p>
        </div>
      </div>

      <UCollapsible v-if="groups.length" v-model:open="detailsOpen">
        <UButton
          :label="detailsOpen ? 'Hide details' : 'Show details'"
          :trailing-icon="detailsOpen ? 'i-ph-caret-up' : 'i-ph-caret-down'"
          color="neutral"
          variant="link"
          size="xs"
          class="p-0"
        />

        <template #content>
          <div class="mt-2 space-y-3 text-xs">
            <div v-for="group in groups" :key="group.key" class="space-y-1">
              <p class="flex flex-wrap items-baseline gap-x-2 font-medium text-default">
                <span>{{ group.title }}</span>
                <span v-if="group.path" class="font-mono font-normal break-all text-muted">{{ group.path }}</span>
                <span v-if="group.note" class="font-normal text-muted">{{ group.note }}</span>
              </p>
              <p v-if="group.lines.length === 0" class="text-muted">
                Nothing to check.
              </p>
              <p v-for="(line, i) in group.lines" :key="i" class="flex items-start gap-1.5">
                <UIcon :name="STATUS_ICON[line.status].icon" class="mt-px size-3.5 shrink-0" :class="STATUS_ICON[line.status].class" />
                <span class="min-w-0 break-words text-muted">{{ line.text }}</span>
              </p>
            </div>
          </div>
        </template>
      </UCollapsible>
    </template>
  </UCard>
</template>
