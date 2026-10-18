<script setup lang="ts">
import type { SecretRef } from '~/types/management'
import type { ExternalCheckBody, ExternalCheckResult } from '~/types/tools'

// Checks the address as typed, saved or not: jack fetches <address>/ping with
// these headers, the way a friend's jack would.
const props = defineProps<{
  url: string
  headers?: Record<string, SecretRef>
}>()

const { request, extractError } = useManagement()

const address = computed(() => props.url.trim())
const checking = ref(false)
const result = ref<ExternalCheckResult | null>(null)
const failure = ref<string | null>(null)

// A result belongs to the address and headers it ran with. Editing either drops
// it, and a check still on its way when that happens is ignored.
let seq = 0
watch(() => JSON.stringify([address.value, props.headers ?? {}]), () => {
  seq++
  checking.value = false
  result.value = null
  failure.value = null
})

async function check() {
  if (!address.value || checking.value)
    return
  const run = ++seq
  checking.value = true
  result.value = null
  failure.value = null
  const body: ExternalCheckBody = { url: address.value }
  if (props.headers && Object.keys(props.headers).length)
    body.headers = props.headers
  try {
    const answer = await request<ExternalCheckResult>('config/jack/external/test', { method: 'POST', body })
    if (run === seq)
      result.value = answer
  }
  catch (err) {
    if (run === seq)
      failure.value = extractError(err, 'Could not check the address.')
  }
  finally {
    if (run === seq)
      checking.value = false
  }
}

// jack's `error` is already plain words; the status alone is the fallback.
const problem = computed(() => {
  const r = result.value
  if (!r || r.ok)
    return null
  if (r.error)
    return r.error
  return r.status == null ? 'Nothing answered at that address.' : `The address answered ${r.status}.`
})

const guideUrl = docsUrl('unraid', '6-open-jack-to-your-friends')
</script>

<template>
  <div class="min-w-0 space-y-1.5">
    <UButton
      label="Check"
      icon="i-ph-plugs"
      color="neutral"
      variant="outline"
      size="sm"
      :loading="checking"
      :disabled="!address"
      @click="check"
    />

    <p v-if="checking" class="text-xs text-muted">
      Checking… this can take up to 10 seconds.
    </p>

    <p v-else-if="result?.ok" class="flex items-start gap-1.5 text-xs text-success">
      <UIcon name="i-ph-check-circle" class="mt-px size-3.5 shrink-0" />
      <span>Answers from this server. Friends outside your network may still be blocked; your friend's import is the real test.</span>
    </p>

    <div v-else-if="problem" class="flex items-start gap-1.5 text-xs">
      <UIcon name="i-ph-x-circle" class="mt-px size-3.5 shrink-0 text-error" />
      <div class="min-w-0 space-y-0.5">
        <p class="break-words text-error">
          {{ problem }}
          <ULink :to="guideUrl" target="_blank" class="font-medium underline">
            Help
          </ULink>
        </p>
        <p class="font-mono break-all text-muted">
          Checked {{ result?.url }}
        </p>
      </div>
    </div>

    <p v-else-if="failure" class="flex items-start gap-1.5 text-xs text-error">
      <UIcon name="i-ph-warning" class="mt-px size-3.5 shrink-0" />
      <span class="min-w-0 break-words">{{ failure }}</span>
    </p>
  </div>
</template>
