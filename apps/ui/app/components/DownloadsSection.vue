<script setup lang="ts">
import type { Form, FormError, FormSchema } from '@nuxt/ui'
import type { DownloadsConfig, DownloadsConfigPatch } from '~/types/management'

const { request, extractError } = useManagement()
const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

// `null` is a real answer here: no downloads block in the config file, so downloads
// are off and the section offers to turn them on.
const { data: downloads, pending, error: loadError } = useDownloadsConfig()

// jack's own record of what still waits for a restart (overview.system.restartPending).
const { overview, refresh: refreshOverview } = useOverview()

// Run once after a save that sets a new completed folder; never on page load.
const { run: runFolderCheck } = useFolderCheck()

// The Container Path the Unraid template maps jack's Downloads folder to.
const TEMPLATE_DOWNLOADS_PATH = '/data/jack'

const RESTART_NOTE = `Unraid: ${RESTART_STEPS}. jack-ui doesn't need a restart.`

// Every tuning knob is `number | null`, where null means "absent from the file" and
// jack's default applies. The switch has no such state: absent and false behave the
// same, so it stays a plain boolean and is written as an absent key when off.
function blankState() {
  return {
    completedPath: '',
    maxConcurrentDownloads: null as number | null,
    maxDownloadAttempts: null as number | null,
    retryBaseDelayMs: null as number | null,
    retryMaxDelayMs: null as number | null,
    retryWindowMs: null as number | null,
    idleTimeoutMs: null as number | null,
    importPollIntervalMs: null as number | null,
    maxManualImportAttempts: null as number | null,
    manualImportBackoffBaseMs: null as number | null,
    manualImportBackoffMaxMs: null as number | null,
    unlinkImportedFiles: false,
  }
}

type State = ReturnType<typeof blankState>

const state = reactive(blankState())
// Snapshot of the last loaded/saved values, so Save stays disabled until something
// actually differs and Revert has somewhere to go back to.
const baseline = ref(JSON.stringify(blankState()))

function seed(config: DownloadsConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    for (const key of Object.keys(state) as Array<keyof State>) {
      const value = config[key]
      if (value != null)
        (state as Record<string, unknown>)[key] = value
    }
  }
  baseline.value = JSON.stringify(state)
}

watch(() => downloads.value, seed, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== baseline.value)
useUnsavedGuard().track('Downloads', dirty)

const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
// Editing again makes the "Saved" confirmation stale, so retire it on the next change.
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

// jack refuses a Completed folder it can't write to with a 400. The message is
// shown on the field, where the fix is, and cleared as soon as the path changes.
const completedPathError = ref<string | null>(null)
watch(() => state.completedPath, () => {
  completedPathError.value = null
})
const completedPathInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('completedPathInput')

function isCompletedPathRefusal(err: unknown, message: string): boolean {
  const e = err as { statusCode?: number, response?: { status?: number }, data?: { error?: { field?: string } } } | null
  if ((e?.response?.status ?? e?.statusCode) !== 400)
    return false
  // `field` once the management API names the field in its errors (plan 3.2).
  return e?.data?.error?.field === 'completedPath' || message.startsWith('jack can\'t write to ')
}

// After a successful save: what a restart of jack would still apply from this
// section, named as the restart banner names it. Read from jack, so it stays right
// across reloads and tabs, and clears once jack has restarted. Null while the
// overview isn't loaded.
const restartLabels = computed(() => {
  const pending = overview.value?.system?.restartPending
  if (!pending)
    return null
  return restartReasonLabels(pending.filter(reason => reason === 'downloads' || reason.startsWith('downloads.')))
})

const savedAlert = computed(() => {
  const labels = restartLabels.value
  if (!labels)
    return { title: 'Saved.', description: undefined }
  if (labels.length)
    return { title: `Saved. Restart the jack container to apply: ${labels.join(', ')}.`, description: RESTART_NOTE }
  return { title: 'Saved.', description: 'Applied right away.' }
})

// A config file with no downloads block gets an invitation to add one rather than a
// dead end, since writing the block is exactly what this form does.
const adding = ref(false)

// The template always mounts the Downloads folder, so the path is known. Prefilling
// leaves the form dirty, and Save works straight away.
function startAdding() {
  state.completedPath = TEMPLATE_DOWNLOADS_PATH
  adding.value = true
}

// The block as a PATCH just wrote it: the form sends every key, and null means the
// key is absent from the file.
function configFromPatch(patch: DownloadsConfigPatch): DownloadsConfig {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value != null)) as DownloadsConfig
}

function validate(s: State): FormError[] {
  if (!s.completedPath.trim())
    return [{ name: 'completedPath', message: 'Enter the folder where finished downloads land.' }]
  return []
}

// Every control is disabled for the duration of this call. The read-back below re-seeds
// the form from the server's answer, which would otherwise silently discard anything
// typed while the request was in flight, and reset the baseline with it, so the lost
// edit wouldn't even leave the form dirty.
async function save() {
  saving.value = true
  saveError.value = null
  completedPathError.value = null
  saved.value = false
  // A new block or a new folder gets the folder check once it's saved.
  const folderChanged = !downloads.value || downloads.value.completedPath !== state.completedPath.trim()
  const patch: DownloadsConfigPatch = {
    completedPath: state.completedPath.trim(),
    maxConcurrentDownloads: state.maxConcurrentDownloads,
    maxDownloadAttempts: state.maxDownloadAttempts,
    retryBaseDelayMs: state.retryBaseDelayMs,
    retryMaxDelayMs: state.retryMaxDelayMs,
    retryWindowMs: state.retryWindowMs,
    idleTimeoutMs: state.idleTimeoutMs,
    importPollIntervalMs: state.importPollIntervalMs,
    maxManualImportAttempts: state.maxManualImportAttempts,
    manualImportBackoffBaseMs: state.manualImportBackoffBaseMs,
    manualImportBackoffMaxMs: state.manualImportBackoffMaxMs,
    // Off is the default, so write it as an absent key rather than an explicit false.
    unlinkImportedFiles: state.unlinkImportedFiles ? true : null,
  }
  try {
    await request('config/downloads', { method: 'PATCH', body: patch })
    // Read back what was written. A failed asyncData refresh would empty
    // `downloads` (and the form with it), so fetch directly and fall back to what
    // was just saved if jack can't be reached right now.
    downloads.value = await request<DownloadsConfig | null>('config/downloads')
      .catch(() => configFromPatch(patch))
    // The stream pushes the new restartPending too, but maybe only after this
    // returns. Fetching it first keeps the alert from flashing "Applied right away".
    // refresh() never rejects.
    await refreshOverview()
    adding.value = false
    saved.value = true
    if (folderChanged)
      void runFolderCheck()
  }
  catch (err) {
    const message = extractError(err, 'Could not save the downloads settings.')
    if (isCompletedPathRefusal(err, message)) {
      completedPathError.value = message
      saveError.value = 'Not saved. Check the Completed folder.'
    }
    else {
      saveError.value = message
    }
  }
  finally {
    saving.value = false
  }
  // The field sits at the top of a long form, and was disabled until now.
  if (completedPathError.value) {
    await nextTick()
    completedPathInput.value?.inputRef?.focus()
  }
}

function revert() {
  seed(downloads.value ?? null)
  form.value?.clear()
  saveError.value = null
  completedPathError.value = null
  saved.value = false
  // Reverting a block that was never saved means backing out of adding it entirely.
  if (!downloads.value)
    adding.value = false
}

// The two collapsed groups. `custom` counts the keys in a group that carry a value
// other than jack's default, so a collapsed group still says whether it holds
// anything you set yourself.
const transferKeys = ['maxDownloadAttempts', 'retryWindowMs', 'idleTimeoutMs', 'retryBaseDelayMs', 'retryMaxDelayMs'] as const
const importKeys = ['importPollIntervalMs', 'maxManualImportAttempts', 'manualImportBackoffBaseMs', 'manualImportBackoffMaxMs'] as const

const DEFAULTS: Record<string, number> = {
  maxConcurrentDownloads: 3,
  maxDownloadAttempts: 13,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 1_800_000,
  retryWindowMs: 86_400_000,
  idleTimeoutMs: 60_000,
  importPollIntervalMs: 30_000,
  maxManualImportAttempts: 6,
  manualImportBackoffBaseMs: 60_000,
  manualImportBackoffMaxMs: 1_800_000,
}

function customCount(keys: readonly string[]) {
  return keys.filter((key) => {
    const value = (state as Record<string, unknown>)[key]
    return typeof value === 'number' && value !== DEFAULTS[key]
  }).length
}

const transferOpen = ref(false)
const importOpen = ref(false)

const guideUrl = docsUrl('unraid', '5-connect-radarr-and-sonarr')
</script>

<template>
  <SettingsSection
    id="downloads"
    title="Downloads"
    description="Where jack puts what it downloads from friends, and how hard it retries."
  >
    <!-- Only when the first load failed. A save reads the block back itself, so a
         failed read after a save never lands here. -->
    <UAlert v-if="loadError && downloads === undefined" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the downloads settings." />

    <p v-else-if="pending && downloads === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UCard v-else-if="!downloads && !adding" variant="subtle">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
        <p class="max-w-md text-sm text-muted">
          Downloads are off, so friends' movies and episodes can't reach your Radarr/Sonarr.
          The jack template already mounts {{ TEMPLATE_DOWNLOADS_PATH }} for this.
        </p>
        <UButton label="Turn on downloads" icon="i-ph-power" @click="startAdding" />
      </div>
    </UCard>

    <div v-else class="space-y-3">
      <UForm ref="form" :state="state" :validate="validate" class="space-y-3" @submit="save" @error="onError">
        <p class="flex items-start gap-1.5 text-xs text-muted">
          <UIcon name="i-ph-info" class="mt-px size-3.5 shrink-0" />
          <span>
            Completed folder, Download retries and Handing files to Radarr/Sonarr apply after you
            restart the jack container. Downloads at once and Remove jack's copy apply right away.
          </span>
        </p>

        <!-- The two settings you actually choose, kept above the fold. -->
        <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
          <UFormField
            name="completedPath"
            label="Completed folder"
            description="The Container Path of jack's Downloads folder in the Unraid template. Radarr/Sonarr must see this folder at the same path."
            :error="completedPathError ?? undefined"
            required
          >
            <template #hint>
              <UButton :to="guideUrl" target="_blank" label="Help" icon="i-ph-question" color="neutral" variant="link" size="xs" class="p-0" />
            </template>
            <UInput
              ref="completedPathInput"
              v-model="state.completedPath"
              :disabled="saving"
              :placeholder="TEMPLATE_DOWNLOADS_PATH"
              class="w-full font-mono"
            />
          </UFormField>

          <ConfigNumberField
            v-model="state.maxConcurrentDownloads"
            :disabled="saving"
            name="maxConcurrentDownloads"
            label="Downloads at once"
            description="How many downloads from friends run at the same time. Lowering it doesn't stop running downloads."
            :default-value="DEFAULTS.maxConcurrentDownloads!"
            :min="1"
          />

          <USeparator />

          <UFormField
            name="unlinkImportedFiles"
            label="Remove jack's copy after Radarr/Sonarr import it"
            description="Saves disk space. Runs only after a confirmed import; the file in your library stays."
          >
            <USwitch v-model="state.unlinkImportedFiles" :disabled="saving" />
          </UFormField>
        </UCard>

        <!-- Everything below is retry/backoff tuning: collapsed, because the defaults
             are right until something in your setup proves otherwise. -->
        <UCollapsible v-model:open="transferOpen">
          <UButton
            color="neutral"
            variant="subtle"
            block
            :ui="{ label: 'flex-1 text-left' }"
            label="Download retries"
            :icon="transferOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
          >
            <template #trailing>
              <span v-if="customCount(transferKeys)" class="text-xs text-muted">{{ customCount(transferKeys) }} custom</span>
            </template>
          </UButton>

          <template #content>
            <UCard variant="subtle" class="mt-2" :ui="{ body: 'space-y-4' }">
              <p class="text-xs text-muted">
                How a stalled or failing download from a friend is retried.
              </p>
              <ConfigNumberField
                v-model="state.maxDownloadAttempts"
                :disabled="saving"
                name="maxDownloadAttempts"
                label="Attempts before giving up"
                description="How many times a failing download is retried before it's marked failed, unless the retry window below is still open."
                :default-value="DEFAULTS.maxDownloadAttempts!"
                :min="1"
              />
              <ConfigNumberField
                v-model="state.retryWindowMs"
                :disabled="saving"
                name="retryWindowMs"
                label="Retry window"
                description="After a network error or an error from the friend's jack, keep retrying until this long has passed since the download last received data, even when the attempts above are used up. Waiting downloads don't take a download slot. 0 turns it off."
                :default-value="DEFAULTS.retryWindowMs!"
                display-unit="h"
                zero-label="Off"
              />
              <ConfigNumberField
                v-model="state.idleTimeoutMs"
                :disabled="saving"
                name="idleTimeoutMs"
                label="Stall timeout"
                description="How long a download may receive no data before jack treats it as stalled and retries."
                :default-value="DEFAULTS.idleTimeoutMs!"
                display-unit="s"
                :min="1000"
              />
              <ConfigNumberField
                v-model="state.retryBaseDelayMs"
                :disabled="saving"
                name="retryBaseDelayMs"
                label="First retry delay"
                description="Starting point for the backoff between retries. Each further attempt waits longer."
                :default-value="DEFAULTS.retryBaseDelayMs!"
                display-unit="s"
              />
              <ConfigNumberField
                v-model="state.retryMaxDelayMs"
                :disabled="saving"
                name="retryMaxDelayMs"
                label="Longest retry delay"
                description="Ceiling for that backoff."
                :default-value="DEFAULTS.retryMaxDelayMs!"
                display-unit="min"
              />
            </UCard>
          </template>
        </UCollapsible>

        <UCollapsible v-model:open="importOpen">
          <UButton
            color="neutral"
            variant="subtle"
            block
            :ui="{ label: 'flex-1 text-left' }"
            label="Handing files to Radarr/Sonarr"
            :icon="importOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
          >
            <template #trailing>
              <span v-if="customCount(importKeys)" class="text-xs text-muted">{{ customCount(importKeys) }} custom</span>
            </template>
          </UButton>

          <template #content>
            <UCard variant="subtle" class="mt-2" :ui="{ body: 'space-y-4' }">
              <p class="text-xs text-muted">
                jack checks each Radarr/Sonarr that receives downloads to see when a finished download
                was imported, and starts the import itself when Radarr/Sonarr won't pick it up on its own.
              </p>
              <ConfigNumberField
                v-model="state.importPollIntervalMs"
                :disabled="saving"
                name="importPollIntervalMs"
                label="Import check interval"
                description="How often jack reads the import history of each Radarr/Sonarr."
                :default-value="DEFAULTS.importPollIntervalMs!"
                display-unit="s"
                :min="1000"
              />
              <ConfigNumberField
                v-model="state.maxManualImportAttempts"
                :disabled="saving"
                name="maxManualImportAttempts"
                label="Import attempts before giving up"
                description="How many times jack starts an import that Radarr/Sonarr keeps rejecting before it marks the download failed."
                :default-value="DEFAULTS.maxManualImportAttempts!"
                :min="1"
              />
              <ConfigNumberField
                v-model="state.manualImportBackoffBaseMs"
                :disabled="saving"
                name="manualImportBackoffBaseMs"
                label="First import retry delay"
                description="Starting point for the backoff between those attempts."
                :default-value="DEFAULTS.manualImportBackoffBaseMs!"
                display-unit="min"
              />
              <ConfigNumberField
                v-model="state.manualImportBackoffMaxMs"
                :disabled="saving"
                name="manualImportBackoffMaxMs"
                label="Longest import retry delay"
                description="Ceiling for that backoff."
                :default-value="DEFAULTS.manualImportBackoffMaxMs!"
                display-unit="min"
              />
            </UCard>
          </template>
        </UCollapsible>

        <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />

        <UAlert
          v-else-if="saved"
          color="success"
          variant="soft"
          icon="i-ph-check-circle"
          :title="savedAlert.title"
          :description="savedAlert.description"
        />

        <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
          <p v-if="showFixHint" class="mr-auto text-xs text-error">
            Fix the highlighted fields to save.
          </p>
          <p v-else class="mr-auto text-xs text-muted">
            Clear a field to use jack's default.
          </p>
          <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
          <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
        </div>
      </UForm>

      <!-- Outside the form: it checks what is saved. Saving a new completed folder runs it. -->
      <FolderCheck v-if="downloads" />
    </div>
  </SettingsSection>
</template>
