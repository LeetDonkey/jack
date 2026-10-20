<script setup lang="ts">
// Shown when a load from jack failed and there is nothing to show in its place.
// jack is usually restarting, so it tries again on a timer, and at once when the
// overview stream reaches jack again, instead of leaving a dead end.
//
// While the layout says jack isn't answering (JackDownNotice), that notice already
// gives the cause, so this shows a quiet "Waiting for jack…" line rather than
// repeating it in red.
const props = withDefaults(defineProps<{
  error: unknown
  retry: () => unknown
  // What a section failed to load, as in "the bandwidth settings". Without it
  // the alert speaks for the whole page.
  what?: string
  intervalMs?: number
}>(), { intervalMs: 5_000 })

const { errorInfo } = useManagement()
const { jackDown } = useJackStatus()

const text = computed(() => loadErrorText(errorInfo(props.error), props.what))

// One try at a time; the timer, Retry now and jack's return share it. A failure
// shows in `error`, which the page passes in again.
const retrying = ref(false)
let inflight: Promise<void> | undefined
function retryNow(): Promise<void> {
  if (!inflight) {
    retrying.value = true
    const run: Promise<void> = Promise.resolve()
      .then(() => props.retry())
      .then(() => {}, () => {})
      .finally(() => {
        retrying.value = false
        if (inflight === run)
          inflight = undefined
      })
    inflight = run
  }
  return inflight
}

let timer: ReturnType<typeof setInterval> | undefined
let unmounted = false
onMounted(() => {
  timer = setInterval(() => void retryNow(), props.intervalMs)
})
onBeforeUnmount(() => {
  unmounted = true
  clearInterval(timer)
})

// Quiet from the moment jack counts as down until the try that jack's return
// starts has answered, so the red alert doesn't flash up in between.
const waitingForJack = ref(false)
watch(jackDown, (down) => {
  if (down)
    waitingForJack.value = true
}, { immediate: true })

// jack is back: try at once. A try that started while jack was away fails, so
// that one is waited out and the next one counts.
onJackBack(async () => {
  try {
    await inflight
    if (!unmounted)
      await retryNow()
  }
  finally {
    waitingForJack.value = false
  }
})
</script>

<template>
  <p v-if="jackDown || waitingForJack" role="status" class="flex items-center gap-2 text-sm text-muted">
    <UIcon name="i-ph-circle-notch" class="size-4 shrink-0 animate-spin" />
    Waiting for jack…
  </p>
  <UAlert
    v-else
    color="error"
    variant="soft"
    icon="i-ph-warning"
    :title="text.title"
    :description="text.description"
    :actions="[{ label: 'Retry now', color: 'error', variant: 'outline', loading: retrying, onClick: () => void retryNow() }]"
  />
</template>
