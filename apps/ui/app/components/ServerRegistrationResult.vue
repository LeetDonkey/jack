<script setup lang="ts">
import type { DestinationRegistration } from '~/types/management'

// What saving a Radarr/Sonarr set up in it, shown in the dialog in place of the
// form: the indexer, the download client, the *arr's tests of both and what to do
// about a failure.
const props = defineProps<{
  // The server's name, which the backend's messages use too.
  name: string
  registration: DestinationRegistration | null
  // The save answered before the *arr finished testing; the card shows the result.
  pending?: boolean
}>()
const emit = defineEmits<{ done: [] }>()

const TONES = {
  ok: { color: 'success', icon: 'i-ph-check-circle', class: 'text-success' },
  warning: { color: 'warning', icon: 'i-ph-warning', class: 'text-warning' },
  error: { color: 'error', icon: 'i-ph-warning-circle', class: 'text-error' },
} as const

const alert = computed(() => {
  const registration = props.registration
  if (!registration)
    return null
  const { tone } = registrationSummary(registration)
  if (tone === 'ok')
    return { ...TONES.ok, title: `jack is set up in ${props.name}.`, description: `${props.name} tested jack's indexer and download client, and both work.` }
  return { ...TONES[tone], title: registration.message ?? `jack couldn't finish setting itself up in ${props.name}.`, description: undefined }
})

const rows = computed(() => {
  const registration = props.registration
  if (!registration)
    return []
  const steps = [
    { label: 'Indexer', step: registration.indexer, test: registration.indexerTest, testError: registration.testErrors.indexer },
    { label: 'Download client', step: registration.downloadClient, test: registration.clientTest, testError: registration.testErrors.downloadClient },
  ]
  return steps.map(({ label, step, test, testError }) => ({
    label,
    detail: registrationStepDetail(step, test, props.name),
    tone: TONES[registrationStepTone(step, test)],
    // The *arr's own words, under the plain-language summary above.
    raw: test === 'failed' ? testError : null,
  }))
})

const fix = computed(() => props.registration ? registrationFix(props.registration) : null)
</script>

<template>
  <div class="space-y-4">
    <p v-if="pending" class="flex items-start gap-2 text-sm text-default">
      <UIcon name="i-ph-circle-notch" class="mt-0.5 size-4 shrink-0 animate-spin text-muted" />
      Still testing. The result appears on the card in a moment.
    </p>

    <template v-else-if="alert">
      <UAlert :color="alert.color" variant="soft" :icon="alert.icon" :title="alert.title" :description="alert.description" />

      <dl class="space-y-2 text-sm">
        <div v-for="row in rows" :key="row.label" class="grid gap-x-3 gap-y-0.5 sm:grid-cols-[8rem_1fr]">
          <dt class="text-muted">
            {{ row.label }}
          </dt>
          <dd class="min-w-0">
            <span class="flex items-start gap-1.5 text-default">
              <UIcon :name="row.tone.icon" class="mt-0.5 size-4 shrink-0" :class="row.tone.class" />
              <span class="min-w-0 break-words">{{ row.detail }}</span>
            </span>
            <span v-if="row.raw" class="mt-1 block break-words pl-5.5 font-mono text-xs text-muted">{{ row.raw }}</span>
          </dd>
        </div>
      </dl>
    </template>

    <div class="flex flex-wrap justify-end gap-2 pt-2">
      <UButton v-if="fix" :label="fix.label" :to="settingsLink(fix.section)" color="neutral" variant="ghost" @click="emit('done')" />
      <UButton label="Done" @click="emit('done')" />
    </div>
  </div>
</template>
