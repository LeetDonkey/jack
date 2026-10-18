<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { PeerInput } from '~/types/management'
import { decodeQuickLink } from '~/utils/quick-link'

const emit = defineEmits<{ imported: [PeerInput] }>()
const open = defineModel<boolean>('open', { required: true })
const state = reactive({ link: '' })
const error = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    state.link = ''
    error.value = null
  }
  else {
    state.link = ''
  }
})

function validate(s: typeof state): FormError[] {
  return s.link.trim() ? [] : [{ name: 'link', message: 'Paste the quick link your friend sent.' }]
}

function importLink() {
  error.value = null
  try {
    const peer = decodeQuickLink(state.link)
    state.link = ''
    open.value = false
    emit('imported', peer)
  }
  catch {
    error.value = 'This isn\'t a valid jack quick link. Check that you copied all of it.'
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Add via quick link">
    <template #body>
      <UForm :state="state" :validate="validate" class="space-y-4" @submit="importLink">
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-shield-warning"
          title="A quick link contains a key to your friend's jack."
          description="Only use a link your friend sent you directly. You can check every field before the friend is added."
        />
        <UFormField name="link" label="Quick link" required>
          <UTextarea v-model="state.link" :rows="6" autocomplete="off" placeholder="jack-link:v1:…" class="w-full font-mono text-xs" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
        <div class="flex justify-end gap-2 pt-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="() => { open = false }" />
          <UButton type="submit" label="Continue" icon="i-ph-arrow-right" />
        </div>
      </UForm>
    </template>
  </UModal>
</template>
