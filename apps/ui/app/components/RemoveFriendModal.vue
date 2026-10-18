<script setup lang="ts">
import type { Friend, FriendPeer } from '~/types/management'

const props = defineProps<{
  friend: Friend | null
  // Other addresses for the same jack (`unlinked.peers` with this card's key as
  // `sameAs`). "Stop downloading" removes them too, or jack keeps using one.
  otherAddresses?: FriendPeer[]
}>()
const emit = defineEmits<{ removed: [] }>()
const open = defineModel<boolean>('open', { required: true })

const { request, extractError } = useManagement()
const toast = useToast()

// Copied when the dialog opens, so its text doesn't change while a refresh lands
// or while it animates out.
const target = ref<Friend | null>(null)
const addresses = ref<FriendPeer[]>([])
const stopDownloading = ref(true)
const revoke = reactive<Record<number, boolean>>({})
const removing = ref(false)
const error = ref<string | null>(null)
// What a partly failed removal already did; hidden, so a second try skips it.
const done = reactive(new Set<string>())

watch(open, (isOpen) => {
  if (!isOpen || !props.friend)
    return
  target.value = props.friend
  addresses.value = [...(props.otherAddresses ?? [])]
  stopDownloading.value = true
  for (const id of Object.keys(revoke))
    delete revoke[Number(id)]
  for (const key of props.friend.keys)
    revoke[key.id] = true
  error.value = null
  done.clear()
}, { immediate: true })

const name = computed(() => target.value?.name ?? '')
const keyLabel = (key: { id: number, name: string | null }) => key.name?.trim() ? `'${key.name.trim()}'` : `#${key.id}`
const mainPeerPending = computed(() => Boolean(target.value?.peer) && !done.has('peer'))
const pendingAddresses = computed(() => addresses.value.filter(peer => !done.has(`peer:${peer.id}`)))
const peerPending = computed(() => mainPeerPending.value || pendingAddresses.value.length > 0)
const pendingKeys = computed(() => target.value?.keys.filter(key => !done.has(`key:${key.id}`)) ?? [])
const nothingTicked = computed(() => !(peerPending.value && stopDownloading.value) && !pendingKeys.value.some(key => revoke[key.id]))
const stopDescription = computed(() => {
  const text = 'Removes their jack from your friends. Searches stop using their library right away; downloads in progress finish.'
  const urls = pendingAddresses.value.map(peer => peer.url)
  if (!urls.length)
    return text
  return `${text} Also removes their other address${urls.length === 1 ? '' : 'es'} ${urls.join(', ')}.`
})

async function removePeer(id: string, doneKey: string, failure: string, failures: string[]): Promise<boolean> {
  try {
    await request(`config/peers/${id}`, { method: 'DELETE' })
    done.add(doneKey)
    return true
  }
  catch (err) {
    failures.push(extractError(err, failure))
    return false
  }
}

async function remove() {
  const friend = target.value
  if (!friend || removing.value || nothingTicked.value)
    return
  removing.value = true
  error.value = null
  const failures: string[] = []
  let removedAny = false
  if (stopDownloading.value) {
    if (friend.peer && mainPeerPending.value)
      removedAny = await removePeer(friend.peer.id, 'peer', `Could not stop downloading from ${friend.name}.`, failures) || removedAny
    for (const peer of pendingAddresses.value)
      removedAny = await removePeer(peer.id, `peer:${peer.id}`, `Could not remove ${friend.name}'s other address ${peer.url}.`, failures) || removedAny
  }
  for (const key of pendingKeys.value) {
    if (!revoke[key.id])
      continue
    try {
      await request(`api-keys/${key.id}`, { method: 'DELETE' })
      removedAny = true
      done.add(`key:${key.id}`)
    }
    catch (err) {
      failures.push(extractError(err, `Could not revoke key ${keyLabel(key)}.`))
    }
  }
  removing.value = false
  if (removedAny)
    emit('removed')
  if (failures.length) {
    error.value = failures.join(' ')
    return
  }
  toast.add({ color: 'success', icon: 'i-ph-check-circle', title: `Removed ${friend.name}.` })
  open.value = false
}

const modalOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (!value && removing.value)
      return
    open.value = value
  },
})
</script>

<template>
  <UModal v-model:open="modalOpen" :title="`Remove ${name}?`" :dismissible="!removing" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div v-if="target" class="space-y-4">
        <p v-if="peerPending && pendingKeys.length" class="text-sm text-muted">
          You download from {{ name }}, and {{ name }} downloads from you. Untick what you want to keep.
        </p>
        <UCheckbox
          v-if="peerPending"
          v-model="stopDownloading"
          :label="`Stop downloading from ${name}`"
          :description="stopDescription"
          :ui="{ description: 'break-words' }"
        />
        <UCheckbox
          v-for="key in pendingKeys"
          :key="key.id"
          v-model="revoke[key.id]"
          :label="`Revoke ${name}'s access (key ${keyLabel(key)})`"
          description="Their jack can no longer search or download from you. This can't be undone; they need a new link to come back."
        />
        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
      </div>
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="removing" @click="() => { open = false }" />
      <UButton label="Remove" color="error" :loading="removing" :disabled="nothingTicked" @click="remove" />
    </template>
  </UModal>
</template>
