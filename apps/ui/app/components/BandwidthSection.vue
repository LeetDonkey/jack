<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { BandwidthConfig, BandwidthConfigPatch, Weekday } from '~/types/management'
import { kibToSave, limitError, mbFromKib } from '~/utils/bandwidth-limits'

const { request, extractError } = useManagement()
const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

const { data: bandwidth, pending, error: loadError, refresh } = useLazyAsyncData(
  'bandwidth-config',
  () => request<BandwidthConfig | null>('config/bandwidth'),
)

// PauseControls loads the pauses under this key; null means this jack can't pause.
// v-show, not v-if: hiding must not unmount the controls that load it.
const { data: pauses } = useNuxtData('transfers-pause')
const pauseSupported = computed(() => pauses.value !== null)
const { data: downloadsConfig } = useDownloadsConfig()

const WEEKDAYS: { key: Weekday, label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
]

interface PeriodState {
  days: Weekday[]
  start: string
  end: string
  downloadMb: number | null
  uploadMb: number | null
  /** The limits as loaded (KiB/s), saved unchanged while the fields still show them. Null in a new period. */
  stored: { downloadKib: number | null, uploadKib: number | null }
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
    state.downloadMb = mbFromKib(config.downloadLimitKiBps)
    state.uploadMb = mbFromKib(config.uploadLimitKiBps)
    state.maxConcurrentUploads = config.maxConcurrentUploads ?? null
    state.maxConcurrentUploadsPerPeer = config.maxConcurrentUploadsPerPeer ?? null
    state.dailyUploadLimitGiBPerPeer = config.dailyUploadLimitGiBPerPeer ?? null
    state.schedule = config.schedule.map(p => ({
      days: [...p.days],
      start: p.start,
      end: p.end,
      downloadMb: mbFromKib(p.downloadLimitKiBps),
      uploadMb: mbFromKib(p.uploadLimitKiBps),
      stored: { downloadKib: p.downloadLimitKiBps ?? null, uploadKib: p.uploadLimitKiBps ?? null },
    }))
  }
  baseline.value = JSON.stringify(state)
}

watch(() => bandwidth.value, seed, { immediate: true })

// The number inputs store `v ?? null`: an empty input reports undefined when it
// loses focus, which JSON leaves out. The form would then look edited, and the
// PATCH would keep the stored limit instead of removing it.
const dirty = computed(() => JSON.stringify(state) !== baseline.value)
useUnsavedGuard().track('Bandwidth', dirty)

const saving = ref(false)
const { saveError, failed: saveFailed } = useSaveError()
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

function addPeriod() {
  state.schedule.push({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '07:00', end: '23:00', downloadMb: null, uploadMb: null, stored: { downloadKib: null, uploadKib: null } })
}

const SCHEDULE_ERROR = /^schedule\./

function removePeriod(index: number) {
  state.schedule.splice(index, 1)
  // Errors are keyed by period index, which just shifted.
  recheck(SCHEDULE_ERROR)
}

function toggleDay(period: PeriodState, index: number, day: Weekday) {
  period.days = period.days.includes(day)
    ? period.days.filter(d => d !== day)
    : WEEKDAYS.map(w => w.key).filter(d => d === day || period.days.includes(d))
  recheck(`schedule.${index}.days`)
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function validate(s: State): FormError[] {
  const errors: FormError[] = []
  // A typed 0 is refused: empty already means unlimited, and jack can't store 0.
  const limit = (name: string, message: string | null) => {
    if (message)
      errors.push({ name, message })
  }
  limit('downloadMb', limitError(s.downloadMb, 'download'))
  limit('uploadMb', limitError(s.uploadMb, 'upload'))
  s.schedule.forEach((period, i) => {
    if (period.days.length === 0)
      errors.push({ name: `schedule.${i}.days`, message: 'Pick at least one day.' })
    if (!TIME.test(period.start) || !TIME.test(period.end))
      errors.push({ name: `schedule.${i}.time`, message: 'Enter a start and end time.' })
    limit(`schedule.${i}.downloadMb`, limitError(period.downloadMb, 'download', true))
    limit(`schedule.${i}.uploadMb`, limitError(period.uploadMb, 'upload', true))
  })
  return errors
}

// The day buttons aren't form inputs, so the form doesn't check them again on
// its own. Only errors already on screen are updated.
function recheck(target: string | RegExp) {
  if (!form.value?.getErrors(target).length)
    return
  const matches = (name?: string) => (typeof target === 'string' ? name === target : Boolean(name && target.test(name)))
  form.value.setErrors(validate(state).filter(e => matches(e.name)), target)
}

function periodSummary(period: PeriodState): string {
  const overnight = period.end <= period.start && period.end !== period.start
  return overnight ? 'Runs past midnight into the next day.' : period.start === period.end ? 'Covers the whole day.' : ''
}

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  // The form saves every field, so limits the user didn't touch go out as loaded.
  const loaded = bandwidth.value
  const patch: BandwidthConfigPatch = {
    downloadLimitKiBps: kibToSave(state.downloadMb, loaded?.downloadLimitKiBps),
    uploadLimitKiBps: kibToSave(state.uploadMb, loaded?.uploadLimitKiBps),
    maxConcurrentUploads: state.maxConcurrentUploads,
    maxConcurrentUploadsPerPeer: state.maxConcurrentUploadsPerPeer,
    dailyUploadLimitGiBPerPeer: state.dailyUploadLimitGiBPerPeer,
    schedule: state.schedule.length === 0
      ? null
      : state.schedule.map((p) => {
          const download = kibToSave(p.downloadMb, p.stored.downloadKib)
          const upload = kibToSave(p.uploadMb, p.stored.uploadKib)
          return {
            days: p.days,
            start: p.start,
            end: p.end,
            ...(download != null ? { downloadLimitKiBps: download } : {}),
            ...(upload != null ? { uploadLimitKiBps: upload } : {}),
          }
        }),
  }
  try {
    await request('config/bandwidth', { method: 'PATCH', body: patch })
    await refresh()
    saved.value = true
  }
  catch (err) {
    saveFailed(err, extractError(err, 'Could not save the bandwidth settings.'))
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(bandwidth.value ?? null)
  form.value?.clear()
  saveError.value = null
  saved.value = false
}
</script>

<template>
  <SettingsSection
    id="bandwidth"
    title="Bandwidth"
    description="Combined speed limits for everything jack moves to and from friends, and a weekly schedule that overrides them."
  >
    <!-- Pausing applies right away and isn't part of the form below. -->
    <UCard v-show="pauseSupported" variant="subtle" class="mb-3" :ui="{ body: 'space-y-3' }">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm font-medium text-highlighted">
            Pause sharing
          </p>
          <p class="text-xs text-muted">
            Friends' jacks are told sharing is paused and try again later. Uploads already running finish.
          </p>
        </div>
        <PauseControls what="uploads" />
      </div>
      <USeparator />
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm font-medium text-highlighted">
            Pause downloads
          </p>
          <p class="text-xs text-muted">
            <template v-if="downloadsConfig === null">
              Downloads are off, so there's nothing to pause.
            </template>
            <template v-else>
              New downloads from friends wait in the queue. Downloads already running finish.
            </template>
          </p>
        </div>
        <PauseControls what="downloads" />
      </div>
    </UCard>

    <LoadErrorAlert v-if="loadError" :error="loadError" :retry="refresh" what="the bandwidth settings" />

    <p v-else-if="pending && bandwidth === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else ref="form" :state="state" :validate="validate" class="space-y-3" @submit="save" @error="onError">
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <!-- step-snapping off keeps a typed value as typed: with a 0.5 step, 0.2
             would become 0, and with a 10 step from 1, a typed 25 would become 21. -->
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField name="downloadMb" label="Download limit" description="Across all friends. Empty means unlimited." hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
            <UInputNumber :model-value="state.downloadMb" :disabled="saving" :min="0" :step="0.5" :step-snapping="false" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" @update:model-value="v => (state.downloadMb = v ?? null)" />
          </UFormField>
          <UFormField name="uploadMb" label="Upload limit" description="Across all friends. Empty means unlimited." hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
            <UInputNumber :model-value="state.uploadMb" :disabled="saving" :min="0" :step="0.5" :step-snapping="false" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" @update:model-value="v => (state.uploadMb = v ?? null)" />
          </UFormField>
        </div>

        <UFormField
          name="maxConcurrentUploads"
          label="Uploads at once"
          description="How many friends may download from you at once. Others are asked to retry a minute later. Empty means unlimited."
        >
          <UInputNumber :model-value="state.maxConcurrentUploads" :disabled="saving" :min="1" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" @update:model-value="v => (state.maxConcurrentUploads = v ?? null)" />
        </UFormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            name="maxConcurrentUploadsPerPeer"
            label="Uploads at once per friend"
            description="So one friend can't take every upload slot. Each key counts as one friend."
          >
            <UInputNumber :model-value="state.maxConcurrentUploadsPerPeer" :disabled="saving" :min="1" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" @update:model-value="v => (state.maxConcurrentUploadsPerPeer = v ?? null)" />
          </UFormField>
          <UFormField
            name="dailyUploadLimitGiBPerPeer"
            label="Daily limit per friend"
            description="How much one friend may download from you per day. Past it, their jack waits until midnight."
            hint="GB"
            :ui="{ hint: 'font-mono text-xs text-dimmed' }"
          >
            <UInputNumber :model-value="state.dailyUploadLimitGiBPerPeer" :disabled="saving" :min="1" :step="10" :step-snapping="false" :increment="false" :decrement="false" placeholder="Unlimited" class="w-full" @update:model-value="v => (state.dailyUploadLimitGiBPerPeer = v ?? null)" />
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
              period uses the limit above. Times use jack's time zone. On Unraid that's the
              server's own, from Settings -> Date and Time; elsewhere, set TZ on the jack container.
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

          <UFormField :name="`schedule.${i}.days`">
            <div class="flex flex-wrap gap-1">
              <UButton
                v-for="day in WEEKDAYS"
                :key="day.key"
                :label="day.label"
                size="xs"
                :color="period.days.includes(day.key) ? 'primary' : 'neutral'"
                :variant="period.days.includes(day.key) ? 'solid' : 'outline'"
                :aria-pressed="period.days.includes(day.key)"
                :disabled="saving"
                @click="toggleDay(period, i, day.key)"
              />
            </div>
          </UFormField>

          <div class="grid gap-3 sm:grid-cols-4">
            <!-- One field holds both times, so the error shows once under the pair
                 and both inputs turn red. Each input brings its own id and label. -->
            <UFormField :name="`schedule.${i}.time`" class="sm:col-span-2">
              <div class="grid grid-cols-2 gap-3">
                <div class="space-y-1">
                  <label :for="`period-${i}-start`" class="block font-medium text-default">From</label>
                  <UInput :id="`period-${i}-start`" v-model="period.start" type="time" :disabled="saving" class="w-full" />
                </div>
                <div class="space-y-1">
                  <label :for="`period-${i}-end`" class="block font-medium text-default">To</label>
                  <UInput :id="`period-${i}-end`" v-model="period.end" type="time" :disabled="saving" class="w-full" />
                </div>
              </div>
            </UFormField>
            <UFormField :name="`schedule.${i}.downloadMb`" label="Download" hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
              <UInputNumber :model-value="period.downloadMb" :disabled="saving" :min="0" :step="0.5" :step-snapping="false" :increment="false" :decrement="false" placeholder="Same as above" class="w-full" @update:model-value="v => (period.downloadMb = v ?? null)" />
            </UFormField>
            <UFormField :name="`schedule.${i}.uploadMb`" label="Upload" hint="MB/s" :ui="{ hint: 'font-mono text-xs text-dimmed' }">
              <UInputNumber :model-value="period.uploadMb" :disabled="saving" :min="0" :step="0.5" :step-snapping="false" :increment="false" :decrement="false" placeholder="Same as above" class="w-full" @update:model-value="v => (period.uploadMb = v ?? null)" />
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
        <p v-if="showFixHint" class="text-xs text-error">
          Fix the highlighted fields to save.
        </p>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
