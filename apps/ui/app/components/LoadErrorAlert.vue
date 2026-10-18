<script setup lang="ts">
// Shown when a page's first load from jack fails. jack is usually restarting,
// so retry on a timer instead of leaving a dead end.
const props = withDefaults(defineProps<{
  error: unknown
  retry: () => unknown
  intervalMs?: number
}>(), { intervalMs: 5_000 })

const { extractError } = useManagement()
const retrying = ref(false)

async function retryNow() {
  retrying.value = true
  try {
    await props.retry()
  }
  finally {
    retrying.value = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (!retrying.value)
      void retryNow()
  }, props.intervalMs)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <UAlert
    color="error"
    variant="soft"
    icon="i-ph-warning"
    title="Can't reach jack. It may be restarting. Retrying automatically…"
    :description="extractError(error, 'No answer from jack.')"
    :actions="[{ label: 'Retry now', color: 'error', variant: 'outline', loading: retrying, onClick: retryNow }]"
  />
</template>
