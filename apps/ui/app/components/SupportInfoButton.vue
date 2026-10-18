<script setup lang="ts">
import type { SupportBundle } from '~/types/tools'

// Button props (size, variant, class, ui…) pass through to the button, not to
// the dialog next to it.
defineOptions({ inheritAttrs: false })

const { request, extractError } = useManagement()
const toast = useToast()

const NOTE = 'Keys, header values and webhook URLs are left out. Error messages and log lines in it can contain the addresses of your Radarr, Sonarr and friends.'

const loading = ref(false)
// Shown to copy by hand when the browser won't let the page copy: jack-ui opened
// over plain http has no clipboard API, and the fallback needs a fresh click.
const manualText = ref<string | null>(null)
const manualFailed = ref(false)
const manualArea = useTemplateRef<HTMLTextAreaElement>('manualArea')
const manualOpen = computed({
  get: () => manualText.value !== null,
  set: (open) => {
    if (!open) {
      manualText.value = null
      manualFailed.value = false
    }
  },
})

function copied() {
  toast.add({ color: 'success', icon: 'i-ph-check-circle', title: 'Support info copied.', description: NOTE })
}

async function copySupportInfo() {
  if (loading.value)
    return
  loading.value = true
  let text: string
  try {
    text = JSON.stringify(await request<SupportBundle>('support-bundle'), null, 2)
  }
  catch (err) {
    toast.add({ color: 'error', icon: 'i-ph-warning', title: 'Could not get the support info.', description: extractError(err, 'No answer from jack.') })
    return
  }
  finally {
    loading.value = false
  }
  if (await copyTextToClipboard(text))
    copied()
  else
    manualText.value = text
}

async function copyManual() {
  if (manualText.value === null)
    return
  manualFailed.value = false
  if (await copyTextToClipboard(manualText.value)) {
    manualText.value = null
    copied()
    return
  }
  manualFailed.value = true
  manualArea.value?.focus()
  manualArea.value?.select()
}

function selectAll(event: FocusEvent) {
  (event.target as HTMLTextAreaElement).select()
}
</script>

<template>
  <UButton
    label="Copy support info"
    icon="i-ph-lifebuoy"
    color="neutral"
    variant="outline"
    v-bind="$attrs"
    :loading="loading"
    @click="copySupportInfo"
  />

  <UModal v-model:open="manualOpen" title="Support info" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div class="space-y-3">
        <p class="text-sm text-default">
          This browser doesn't let the page copy here. Select the text and copy it, or try Copy below.
        </p>
        <p class="text-xs text-muted">
          {{ NOTE }}
        </p>
        <textarea
          ref="manualArea"
          :value="manualText ?? ''"
          readonly
          rows="12"
          aria-label="Support info"
          class="w-full resize-y rounded-md border border-default bg-elevated/40 p-2 font-mono text-xs text-default"
          @focus="selectAll"
        />
        <p v-if="manualFailed" class="text-xs text-warning">
          That didn't work either. The text is selected: copy it with Ctrl+C (or Cmd+C).
        </p>
      </div>
    </template>
    <template #footer="{ close }">
      <UButton label="Close" color="neutral" variant="ghost" @click="close" />
      <UButton label="Copy" icon="i-ph-copy" @click="copyManual" />
    </template>
  </UModal>
</template>
