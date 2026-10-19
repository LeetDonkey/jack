<script setup lang="ts">
import type { Friend, FriendPeer } from '~/types/management'

const props = defineProps<{
  friend: Friend | null
  // Other addresses for the same jack (`unlinked.peers` with this card's key as
  // `sameAs`). "Stop downloading" removes them too, or jack keeps using one.
  otherAddresses?: FriendPeer[]
  // When each key was created (GET /api-keys), to tell several keys apart.
  keyCreatedAt?: Record<number, string>
}>()
const emit = defineEmits<{ removed: [] }>()
const open = defineModel<boolean>('open', { required: true })

const { request, extractError } = useManagement()
const toast = useToast()

// Copied when the dialog opens, so its text doesn't change while a refresh lands
// or while it animates out.
const target = ref<Friend | null>(null)
const addresses = ref<FriendPeer[]>([])
const keyLabels = ref<Record<number, string | null>>({})
const keyUsages = ref<Record<number, string>>({})
const stopDownloading = ref(true)
const revoke = reactive<Record<number, boolean>>({})
const removing = ref(false)
const error = ref<string | null>(null)
// What a partly failed removal already did; hidden, so a second try skips it.
const done = reactive(new Set<string>())

// Several keys usually means "Keep both" on a new link, and the user came to
// revoke the old one: nothing starts ticked, so the defaults don't remove the friend.
const severalKeys = computed(() => (target.value?.keys.length ?? 0) > 1)

watch(open, (isOpen) => {
  if (!isOpen || !props.friend)
    return
  const now = new Date()
  target.value = props.friend
  addresses.value = [...(props.otherAddresses ?? [])]
  keyLabels.value = friendKeyLabels(props.friend.name, props.friend.keys, props.keyCreatedAt, now)
  keyUsages.value = Object.fromEntries(props.friend.keys.map(key => [key.id, keyUsage(key, props.keyCreatedAt?.[key.id], now)]))
  const tick = props.friend.keys.length <= 1
  stopDownloading.value = tick
  for (const id of Object.keys(revoke))
    delete revoke[Number(id)]
  for (const key of props.friend.keys)
    revoke[key.id] = tick
  error.value = null
  done.clear()
}, { immediate: true })

const name = computed(() => target.value?.name ?? '')
const keyName = (id: number) => keyLabels.value[id] ?? `#${id}`
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

function singleKeyLabel(id: number): string {
  const label = keyLabels.value[id]
  return label ? `Revoke ${name.value}'s access (key ${label})` : `Revoke ${name.value}'s access`
}

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
  let stopped = false
  let revoked = 0
  if (stopDownloading.value) {
    if (friend.peer && mainPeerPending.value)
      stopped = await removePeer(friend.peer.id, 'peer', `Could not stop downloading from ${friend.name}.`, failures) || stopped
    for (const peer of pendingAddresses.value)
      stopped = await removePeer(peer.id, `peer:${peer.id}`, `Could not remove ${friend.name}'s other address ${peer.url}.`, failures) || stopped
  }
  for (const key of pendingKeys.value) {
    if (!revoke[key.id])
      continue
    try {
      await request(`api-keys/${key.id}`, { method: 'DELETE' })
      revoked++
      done.add(`key:${key.id}`)
    }
    catch (err) {
      failures.push(extractError(err, `Could not revoke key ${keyName(key.id)}.`))
    }
  }
  removing.value = false
  if (stopped || revoked)
    emit('removed')
  if (failures.length) {
    error.value = failures.join(' ')
    return
  }
  toast.add({ color: 'success', icon: 'i-ph-check-circle', title: doneSummary(friend.name, stopped, revoked) })
  open.value = false
}

// "Removed Alice." when nothing of the friend is left, otherwise what changed.
function doneSummary(friendName: string, stopped: boolean, revoked: number): string {
  if (!peerPending.value && !pendingKeys.value.length)
    return `Removed ${friendName}.`
  const parts: string[] = []
  if (stopped)
    parts.push(`Stopped downloading from ${friendName}.`)
  if (revoked)
    parts.push(revoked === 1 ? 'Revoked 1 key.' : `Revoked ${revoked} keys.`)
  return parts.join(' ')
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
        <p v-if="severalKeys && pendingKeys.length" class="text-sm text-muted">
          {{ name }} has {{ target.keys.length }} keys to download from you. Tick only what you want to remove.
        </p>
        <p v-else-if="peerPending && pendingKeys.length" class="text-sm text-muted">
          You download from {{ name }}, and {{ name }} downloads from you. Untick what you want to keep.
        </p>
        <UCheckbox
          v-if="peerPending"
          v-model="stopDownloading"
          :label="`Stop downloading from ${name}`"
          :description="stopDescription"
          :ui="{ description: 'break-words' }"
        />
        <template v-if="severalKeys">
          <UCheckbox
            v-for="key in pendingKeys"
            :key="key.id"
            v-model="revoke[key.id]"
            :label="`Revoke key ${keyName(key.id)}`"
            :description="`${keyUsages[key.id]}.`"
          />
          <p v-if="pendingKeys.length" class="text-xs text-muted">
            Revoking can't be undone. If you revoke every key, {{ name }} needs a new link to download from you again.
          </p>
        </template>
        <template v-else>
          <UCheckbox
            v-for="key in pendingKeys"
            :key="key.id"
            v-model="revoke[key.id]"
            :label="singleKeyLabel(key.id)"
            description="Their jack can no longer search or download from you. This can't be undone; they need a new link to come back."
          />
        </template>
        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
      </div>
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="removing" @click="() => { open = false }" />
      <UButton label="Remove" color="error" :loading="removing" :disabled="nothingTicked" @click="remove" />
    </template>
  </UModal>
</template>
