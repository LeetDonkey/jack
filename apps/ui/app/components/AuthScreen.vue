<script setup lang="ts">
import type { ButtonProps, FormError } from '@nuxt/ui'

const { state, login, refresh } = useAuth()

const form = reactive({ key: '' })
const submitting = ref(false)
const error = ref<string | null>(null)

function validate(s: typeof form): FormError[] {
  return s.key.trim() ? [] : [{ name: 'key', message: 'Enter the Management key.' }]
}

async function onSubmit() {
  submitting.value = true
  error.value = null
  try {
    await login(form.key.trim())
    form.key = ''
  }
  catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 401) {
      error.value = 'That key doesn\'t match the Management key in the jack template.'
    }
    else {
      error.value = 'jack didn\'t answer. Try again in a moment.'
      // jack was answering when this form appeared; if it has gone since, the
      // probe swaps the form for the "can't reach jack" screen.
      await refresh()
    }
  }
  finally {
    submitting.value = false
  }
}

const retrying = ref(false)
async function retry() {
  retrying.value = true
  try {
    await refresh()
  }
  finally {
    retrying.value = false
  }
}

function actions(color: 'warning' | 'error'): ButtonProps[] {
  return [
    { label: 'Retry', color, variant: 'soft', loading: retrying.value, onClick: retry },
    {
      label: 'Troubleshooting guide',
      to: docsUrl('unraid', 'troubleshooting'),
      target: '_blank',
      trailingIcon: 'i-ph-arrow-square-out',
      color: 'neutral',
      variant: 'link',
    },
  ]
}

const CHECK_RUNNING = 'Check that the jack container is running (Docker tab) and look at its log. If the log shows EACCES, jack can\'t write to its appdata folder: the troubleshooting guide has the fix.'

// The probe's reason (server/api/ping.get.ts) picks the copy. Docker's DNS drops
// a stopped container's name, so `dns` also covers a jack that has stopped. The
// Management key check comes last: jack's template requires it. The URL, when
// known, goes between `lead` and `suffix`.
const unreachable = computed<{ lead: string, suffix?: string, checks: string[] }>(() => {
  switch (state.value.reason) {
    case 'dns':
      return {
        lead: 'jack-ui can\'t find jack',
        checks: [
          CHECK_RUNNING,
          'Check that both containers are on the jack network and the jack container is named jack.',
        ],
      }
    case 'timeout':
      return {
        lead: 'jack didn\'t answer',
        suffix: ' within 5 seconds',
        checks: [
          CHECK_RUNNING,
          'Check the Management API address in the jack-ui template (under Show more settings). The default, http://jack:5226, works when both containers are on the jack network.',
        ],
      }
    default:
      return {
        lead: 'jack isn\'t answering',
        checks: [
          CHECK_RUNNING,
          'Check that the Management key in the jack template isn\'t empty. Without it, jack doesn\'t let jack-ui connect.',
        ],
      }
  }
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <div class="w-full max-w-md space-y-6">
      <div class="flex flex-col items-center gap-2 text-center">
        <UIcon name="i-ph-plugs-connected" class="size-9 text-primary" />
        <div>
          <h1 class="text-2xl font-semibold tracking-tight text-highlighted">
            jack
          </h1>
          <p class="text-sm text-muted">
            management console
          </p>
        </div>
      </div>

      <!-- Loading -->
      <UCard v-if="state.status === 'loading'">
        <p class="flex items-center justify-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
          Connecting to jack…
        </p>
      </UCard>

      <!-- jack-ui can't reach jack's management API -->
      <UAlert
        v-else-if="state.status === 'disabled'"
        color="warning"
        variant="soft"
        icon="i-ph-plugs"
        title="jack-ui can't reach jack"
        :actions="actions('warning')"
      >
        <template #description>
          <p>
            {{ unreachable.lead }}<span v-if="state.url"> at <code class="rounded bg-elevated px-1 py-0.5 text-xs">{{ state.url }}</code></span>{{ unreachable.suffix }}.
          </p>
          <ul class="mt-2 list-disc space-y-1 pl-4">
            <li v-for="check in unreachable.checks" :key="check">
              {{ check }}
            </li>
          </ul>
        </template>
      </UAlert>

      <!-- jack rejected the key from the jack-ui template -->
      <UAlert
        v-else-if="state.status === 'error' && state.reason === 'unauthorized'"
        color="error"
        variant="soft"
        icon="i-ph-key"
        title="jack rejected jack-ui's key"
        description="The Management key in the jack-ui template doesn't match the one in the jack template. Copy the value from the jack template into the jack-ui template and click Apply."
        :actions="actions('error')"
      />

      <!-- Unexpected error -->
      <UAlert
        v-else-if="state.status === 'error'"
        color="error"
        variant="soft"
        icon="i-ph-x-circle"
        title="Something went wrong"
        :description="state.message ?? 'jack-ui got an unexpected answer from jack.'"
        :actions="actions('error')"
      />

      <!-- Needs key: cookie-mode login prompt -->
      <UCard v-else>
        <UForm :state="form" :validate="validate" class="space-y-4" @submit="onSubmit">
          <div>
            <h2 class="font-medium text-highlighted">
              Enter the Management key
            </h2>
            <p class="mt-1 text-sm text-muted">
              Use the Management key from the jack template. jack-ui keeps it in a secure cookie that the page can't read.
            </p>
          </div>

          <UFormField name="key" :error="error ?? undefined">
            <UInput
              v-model="form.key"
              type="password"
              autocomplete="current-password"
              placeholder="Paste the Management key"
              icon="i-ph-key"
              class="w-full"
            />
          </UFormField>

          <UButton
            type="submit"
            block
            :loading="submitting"
            :label="submitting ? 'Checking…' : 'Unlock'"
          />
        </UForm>
      </UCard>
    </div>
  </div>
</template>
