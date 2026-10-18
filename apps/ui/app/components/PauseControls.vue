<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { PausesAnswer, PauseStates, PauseTarget, TransfersWithPause } from '~/types/tools'
import type { PauseChoice } from '~/utils/pause'
import { INDEFINITE_SHARING_WARNING, isPauseActive, pauseChoiceLabel, pauseStateText, pauseUntil } from '~/utils/pause'

const props = defineProps<{ what: PauseTarget }>()

const { request, extractError } = useManagement()

// Both directions' pauses, shared by every PauseControls on the page and kept live
// by the transfers stream (one connection however many subscribe). Null when this
// jack doesn't report pauses.
const { data: paused } = useLazyAsyncData('transfers-pause', () =>
  request<TransfersWithPause>('transfers').then((snapshot): PauseStates | null => snapshot.paused ?? null))
useManagementStream<TransfersWithPause>('transfers/stream', (snapshot) => {
  paused.value = snapshot.paused ?? null
})

// With downloads off there is nothing to pause, so the control stays away.
const { data: downloadsConfig } = useDownloadsConfig()
const downloadsOff = computed(() => props.what === 'downloads' && downloadsConfig.value === null)

// A timed pause ends by itself; jack says so on the stream, and the clock covers
// the moment the stream is down.
const now = ref(new Date())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clock = setInterval(() => {
    now.value = new Date()
  }, 15_000)
})
onBeforeUnmount(() => clearInterval(clock))

const state = computed(() => paused.value?.[props.what])
const active = computed(() => isPauseActive(state.value, now.value))
const stateText = computed(() => pauseStateText(props.what, state.value, now.value))
const showIndefiniteWarning = computed(() => props.what === 'uploads' && active.value && Boolean(state.value?.indefinite))

const noun = computed(() => (props.what === 'uploads' ? 'sharing' : 'downloads'))
const pauseLabel = computed(() => (props.what === 'uploads' ? 'Pause sharing' : 'Pause downloads'))

const busy = ref(false)
const actionError = ref<string | null>(null)
// A 409: downloads were turned off since the page loaded.
const conflict = ref(false)

function statusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }, statusCode?: number } | null
  return e?.response?.status ?? e?.statusCode
}

async function send(path: 'transfers/pause' | 'transfers/resume', body: Record<string, string>, fallback: string) {
  busy.value = true
  actionError.value = null
  conflict.value = false
  try {
    const answer = await request<PausesAnswer>(path, { method: 'POST', body })
    paused.value = answer.paused
    now.value = new Date()
  }
  catch (err) {
    conflict.value = statusOf(err) === 409
    actionError.value = conflict.value
      ? 'Downloads are off, so there\'s nothing to pause.'
      : extractError(err, fallback)
  }
  finally {
    busy.value = false
  }
}

function pause(choice: PauseChoice) {
  return send('transfers/pause', { what: props.what, until: pauseUntil(choice, new Date()) }, `Could not pause ${noun.value}.`)
}

function resume() {
  return send('transfers/resume', { what: props.what }, `Could not resume ${noun.value}.`)
}

// Labels are worked out when the menu opens, so "Until tomorrow 08:00" is right
// after midnight too.
const menuNow = ref(new Date())
function onMenuOpen(open: boolean) {
  if (open)
    menuNow.value = new Date()
}

const items = computed<DropdownMenuItem[][]>(() => [
  (['1h', '4h', 'morning'] as const).map(choice => ({
    label: pauseChoiceLabel(choice, menuNow.value),
    onSelect: () => void pause(choice),
  })),
  [{
    label: pauseChoiceLabel('indefinite', menuNow.value),
    description: props.what === 'uploads' ? INDEFINITE_SHARING_WARNING : undefined,
    onSelect: () => void pause('indefinite'),
  }],
])
</script>

<template>
  <div v-if="paused !== null && !downloadsOff" class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
    <template v-if="active">
      <UBadge
        color="warning"
        variant="subtle"
        icon="i-ph-pause-circle"
        :label="stateText ?? ''"
        class="max-w-full"
      />
      <UButton
        label="Resume"
        icon="i-ph-play"
        color="neutral"
        variant="outline"
        size="sm"
        :aria-label="`Resume ${noun}`"
        :loading="busy"
        @click="resume"
      />
    </template>

    <UDropdownMenu v-else :items="items" :content="{ align: 'start' }" :ui="{ content: 'max-w-72', itemDescription: '!whitespace-normal' }" @update:open="onMenuOpen">
      <UButton
        :label="pauseLabel"
        icon="i-ph-pause"
        trailing-icon="i-ph-caret-down"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="busy"
        :disabled="paused === undefined"
      />
    </UDropdownMenu>

    <p v-if="showIndefiniteWarning" class="w-full text-xs text-warning">
      {{ INDEFINITE_SHARING_WARNING }}
    </p>
    <p v-if="actionError" class="w-full text-xs text-error">
      {{ actionError }}
      <ULink v-if="conflict" :to="settingsLink('downloads')" class="font-medium underline">
        Turn on downloads
      </ULink>
    </p>
  </div>
</template>
