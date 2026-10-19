<script setup lang="ts">
import type { Friend } from '~/types/management'
import type { RevokeKeyWords } from '~/utils/friends'

// Revokes one of a friend's keys, for a friend with several (after "Keep both" on
// a new link). Remove friend handles a friend's only key.
const props = defineProps<{
  friend: Friend | null
  keyId: number | null
  // When each key was created (GET /api-keys), to tell the keys apart.
  keyCreatedAt?: Record<number, string>
}>()
const emit = defineEmits<{ revoked: [] }>()
const open = defineModel<boolean>('open', { required: true })

const { request, extractError } = useManagement()
const toast = useToast()

// Copied when the dialog opens, so its text doesn't change while a refresh lands
// or while it animates out.
const target = ref<RevokeKeyWords & { id: number } | null>(null)
const revoking = ref(false)
const error = ref<string | null>(null)

watch(open, (isOpen) => {
  const { friend, keyId } = props
  if (!isOpen || !friend || keyId === null)
    return
  const words = revokeKeyWords(friend.name, friend.keys, keyId, props.keyCreatedAt, new Date())
  if (!words)
    return
  target.value = { ...words, id: keyId }
  error.value = null
}, { immediate: true })

async function revoke() {
  const key = target.value
  if (!key || revoking.value)
    return
  revoking.value = true
  error.value = null
  try {
    await request(`api-keys/${key.id}`, { method: 'DELETE' })
    emit('revoked')
    toast.add({ color: 'success', icon: 'i-ph-check-circle', title: `Revoked key ${key.label}.` })
    open.value = false
  }
  catch (err) {
    error.value = extractError(err, `Could not revoke key ${key.label}.`)
  }
  finally {
    revoking.value = false
  }
}

const modalOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (!value && revoking.value)
      return
    open.value = value
  },
})
</script>

<template>
  <UModal
    v-model:open="modalOpen"
    :title="target ? `Revoke key ${target.label}?` : 'Revoke key?'"
    :dismissible="!revoking"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <div v-if="target" class="space-y-3">
        <p class="text-sm text-muted">
          {{ target.usage }}.
        </p>
        <!-- The key their jack uses: revoking it cuts them off. -->
        <UAlert
          v-if="target.warning"
          color="warning"
          variant="soft"
          icon="i-ph-warning"
          :title="target.warning.title"
          :description="target.warning.text"
        />
        <p class="text-sm text-default">
          {{ target.text }}
        </p>
        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
      </div>
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="revoking" @click="() => { open = false }" />
      <UButton label="Revoke" color="error" :loading="revoking" @click="revoke" />
    </template>
  </UModal>
</template>
