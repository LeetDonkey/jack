<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { BandwidthConfig, BandwidthConfigPatch, Weekday } from '~/types/management'

const { request, extractError } = useManagement()

const { data: bandwidth, pending, error: loadError, refresh } = useLazyAsyncData(
  'bandwidth-config',
  () => request<BandwidthConfig | null>('config/bandwidth'),
)

const WEEKDAYS: { key: Weekday, label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
]

// The config file holds KiB/s; the form edits MB/s (MiB/s, matching the rest of
// the UI's 1024-based units). Empty means unlimited.
const toMb = (kib: number | null | undefined) => (kib == null ? null : Math.round((kib / 1024) * 100) / 100)
const toKib = (mb: number | null) => (mb == null || mb <= 0 ? null : Math.max(1, Math.round(mb * 1024)))

interface PeriodState {
  days: Weekday[]
  start: string
  end: string
  downloadMb: number | null
  uploadMb: number | null
}

function blankState() {
  return {
    downloadMb: null as number | null,
    uploadMb: null as number | null,
    maxConcurrentUploads: null as number | null,
    maxConcurrentUploadsPerPeer: null as number | null,
    dailyUploadLimitGiBPerPeer: null as number | null,
    schedule: [] as PeriodState[],
  }
}

type State = ReturnType<typeof blankState>

const state = reactive(blankState())
const baseline = ref(JSON.stringify(blankState()))

function seed(config: BandwidthConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    state.downloadMb = toMb(config.downloadLimitKiBps)
    state.uploadMb = toMb(config.uploadLimitKiBps)
    state.maxConcurrentUploads = config.maxConcurrentUploads ?? null
    state.maxConcurrentUploadsPerPeer = config.maxConcurrentUploadsPerPeer ?? null
    state.dailyUploadLimitGiBPerPeer = config.dailyUploadLimitGiBPerPeer ?? null
    state.schedule = config.schedule.map(p => ({
      days: [...p.days],
      start: p.start,
      end: p.end,
      downloadMb: toMb(p.downloadLimitKiBps),
      uploadMb: toMb(p.uploadLimitKiBps),
    }))
  }
  baseline.value = JSON.stringify(state)
}

watch(() => bandwidth.value, seed, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== baseline.value)

const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

function addPeriod() {
  state.schedule.push({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '07:00', end: '23:00', downloadMb: null, uploadMb: null })
}

function removePeriod(index: number) {
  state.schedule.splice(index, 1)
}

function toggleDay(period: PeriodState, day: Weekday) {
  period.days = period.days.includes(day)
    ? period.days.filter(d => d !== day)
    : WEEKDAYS.map(w => w.key).filter(d => d === day || period.days.includes(d))
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function validate(s: State): FormError[] {
  const errors: FormError[] = []
  s.schedule.forEach((period, i) => {
    if (period.days.length === 0)
      errors.push({ name: `schedule.${i}`, message: `Period ${i + 1}: pick at least one day.` })
    if (!TIME.test(period.start) || !TIME.test(period.end))
      errors.push({ name: `schedule.${i}`, message: `Period ${i + 1}: enter times as HH:MM.` })
  })
  return errors
}

function periodSummary(period: PeriodState): string {
  const overnight = period.end <= period.start && period.end !== period.start
  return overnight ? 'Runs past midnight into the next day.' : period.start === period.end ? 'Covers the whole day.' : ''
}

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  const patch: BandwidthConfigPatch = {
    downloadLimitKiBps: toKib(state.downloadMb),
    uploadLimitKiBps: toKib(state.uploadMb),
    maxConcurrentUploads: state.maxConcurrentUploads,
    maxConcurrentUploadsPerPeer: state.maxConcurrentUploadsPerPeer,
    dailyUploadLimitGiBPerPeer: state.dailyUploadLimitGiBPerPeer,
    schedule: state.schedule.length === 0
      ? null
      : state.schedule.map(p => ({
          days: p.days,
          start: p.start,
          end: p.end,
          ...(toKib(p.downloadMb) != null ? { downloadLimitKiBps: toKib(p.downloadMb) } : {}),
          ...(toKib(p.uploadMb) != null ? { uploadLimitKiBps: toKib(p.uploadMb) } : {}),
        })),
  }
  try {
    await request('config/bandwidth', { method: 'PATCH', body: patch })
    await refresh()
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the bandwidth settings.')
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(bandwidth.value ?? null)
  saveError.value = null
  saved.value = false
}
</script>

<template>
  <SettingsSection
    title="Bandwidth"
    description="Combined speed limits for everything jack moves to and from peers, and a weekly schedule that overrides them."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the bandwidth settings." />

    <p v-else-if="pending && bandwidth === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else :state="state" :validate="validate" class="space-y-3" @submit="save">
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField name="downloadMb" label="Download limit" description="Across all peers. Empty means unlimited." hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
            <UInputNumber v-model="state.downloadMb" :disabled="saving" :min="0" :step="0.5" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" />
          </UFormField>
          <UFormField name="uploadMb" label="Upload limit" description="Across all peers. Empty means unlimited." hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
            <UInputNumber v-model="state.uploadMb" :disabled="saving" :min="0" :step="0.5" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" />
          </UFormField>
        </div>

        <UFormField
          name="maxConcurrentUploads"
          label="Simultaneous uploads"
          description="How many peers may download from you at once. Others are asked to retry a minute later. Empty means unlimited."
        >
          <UInputNumber v-model="state.maxConcurrentUploads" :disabled="saving" :min="1" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" />
        </UFormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            name="maxConcurrentUploadsPerPeer"
            label="Simultaneous uploads per friend"
            description="So one friend can't take every upload slot. Each API key you issued counts as one friend."
          >
            <UInputNumber v-model="state.maxConcurrentUploadsPerPeer" :disabled="saving" :min="1" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" />
          </UFormField>
          <UFormField
            name="dailyUploadLimitGiBPerPeer"
            label="Daily limit per friend"
            description="How much one friend may download from you per day. Past it, their jack waits until midnight."
            hint="GB"
            :ui="{ hint: 'font-mono text-xs text-dimmed' }"
          >
            <UInputNumber v-model="state.dailyUploadLimitGiBPerPeer" :disabled="saving" :min="1" :step="10" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" />
          </UFormField>
        </div>
      </UCard>

      <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-highlighted">
              Weekly schedule
            </p>
            <p class="text-xs text-muted">
              The first period that matches the current day and time wins. A limit left empty in a
              period uses the limit above. Times are in the server's time zone (the container's TZ).
            </p>
          </div>
          <UButton label="Add period" icon="i-ph-plus" size="sm" variant="soft" :disabled="saving" @click="addPeriod" />
        </div>

        <p v-if="state.schedule.length === 0" class="py-2 text-center text-xs text-muted">
          No periods. The limits above apply around the clock.
        </p>

        <div v-for="(period, i) in state.schedule" :key="i" class="space-y-3 rounded-md border border-default p-3">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium text-muted">
              Period {{ i + 1 }}
            </p>
            <UButton icon="i-ph-trash" size="xs" color="error" variant="ghost" :disabled="saving" aria-label="Remove period" @click="removePeriod(i)" />
          </div>

          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="day in WEEKDAYS"
              :key="day.key"
              :label="day.label"
              size="xs"
              :color="period.days.includes(day.key) ? 'primary' : 'neutral'"
              :variant="period.days.includes(day.key) ? 'solid' : 'outline'"
              :disabled="saving"
              @click="toggleDay(period, day.key)"
            />
          </div>

          <div class="grid gap-3 sm:grid-cols-4">
            <UFormField label="From">
              <UInput v-model="period.start" type="time" :disabled="saving" class="w-full" />
            </UFormField>
            <UFormField label="To">
              <UInput v-model="period.end" type="time" :disabled="saving" class="w-full" />
            </UFormField>
            <UFormField label="Download" hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
              <UInputNumber v-model="period.downloadMb" :disabled="saving" :min="0" :step="0.5" :increment="false" :decrement="false" placeholder="Default" class="w-full" />
            </UFormField>
            <UFormField label="Upload" hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
              <UInputNumber v-model="period.uploadMb" :disabled="saving" :min="0" :step="0.5" :increment="false" :decrement="false" placeholder="Default" class="w-full" />
            </UFormField>
          </div>

          <p v-if="periodSummary(period)" class="text-xs text-muted">
            {{ periodSummary(period) }}
          </p>
        </div>
      </UCard>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="Bandwidth settings apply right away." />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
