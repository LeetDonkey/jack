<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Friend, FriendsLimits } from '~/types/management'

const props = defineProps<{
  friend: Friend
  limits: FriendsLimits
  // When each key was created (GET /api-keys), to tell "Never used" from "Not seen since".
  keyCreatedAt?: Record<number, string>
  // Names of the keys that belong to no friend, for the "Link" suggestion on a peer.
  looseKeyNames?: Record<number, string | null>
  // Peer names by id, for the suggestion on a card without a peer.
  peerNames?: Record<string, string>
  now: Date
  // A Link from this card is being saved.
  linking?: boolean
}>()

const emit = defineEmits<{
  // Send a first link (no key yet), or a new one that replaces the newest key.
  invite: []
  newLink: []
  // Paste their link: add the peer this card lacks, or replace the address and key of one.
  add: []
  pasteNewLink: []
  rename: []
  edit: []
  remove: []
  link: [keyIds: number[], peerId: string]
}>()

const TONE_TEXT = { success: 'text-success', error: 'text-error', warning: 'text-warning', neutral: 'text-dimmed' } as const

const name = computed(() => props.friend.name)
const peer = computed(() => props.friend.peer)
const badge = computed(() => friendBadge(props.friend, props.now))
const status = computed(() => (peer.value ? friendStatusWords(peer.value, props.now.getTime()) : null))
const problem = computed(() => (peer.value ? peerProblem(name.value, peer.value) : null))
const build = computed(() => (peer.value ? buildSummary(peer.value.version, peer.value.build, props.now) : null))
const limitsText = computed(() => limitsSummary(props.limits))

// Name a key only when the card doesn't already say which one it is.
const showKeyNames = computed(() => props.friend.keys.length > 1 || props.friend.keys.some(key => !sameName(key.name, name.value)))
const keyLabel = (key: { id: number, name: string | null }) => key.name?.trim() ? `Key '${key.name.trim()}'` : `Key #${key.id}`

// What this friend needs next, with the button that does it.
const prompt = computed(() => {
  const friend = props.friend
  if (!friend.peer)
    return { text: `You don't download from ${name.value} yet.`, label: `Paste ${name.value}'s link`, icon: 'i-ph-clipboard-text', action: 'add' as const, hint: null }
  if (!friend.keys.length)
    return { text: `${name.value} can't download from you yet.`, label: `Send ${name.value} a link`, icon: 'i-ph-link', action: 'invite' as const, hint: null }
  if (friend.state === 'waiting')
    return { text: `Waiting for ${name.value} to add you.`, label: 'Send a new link', icon: 'i-ph-link', action: 'newLink' as const, hint: 'They add you by pasting the link you sent. Lost it?' }
  return null
})

function runPrompt() {
  const action = prompt.value?.action
  if (action === 'add')
    emit('add')
  else if (action === 'invite')
    emit('invite')
  else if (action === 'newLink')
    emit('newLink')
}

// Keys of no friend whose name matches this peer's ("Link" puts them on this card).
const suggestedKeys = computed(() => {
  if (!peer.value || !props.looseKeyNames)
    return []
  return props.friend.suggestedKeyIds
    .filter(id => id in props.looseKeyNames!)
    .map(id => ({ id, label: props.looseKeyNames![id]?.trim() || `#${id}` }))
})

// On a card without a peer: the peer whose name matches. Hidden while that peer
// isn't in the list (gone since the last refresh).
const suggestedPeer = computed(() => {
  const id = props.friend.suggestedPeerId
  const peerName = id ? props.peerNames?.[id] : undefined
  if (peer.value || !id || !peerName)
    return null
  return { id, name: peerName }
})

const menu = computed<DropdownMenuItem[][]>(() => {
  const items: DropdownMenuItem[] = [{ label: 'Rename', icon: 'i-ph-pencil-simple', onSelect: () => emit('rename') }]
  if (peer.value)
    items.push({ label: 'Change address or key', icon: 'i-ph-plugs', onSelect: () => emit('edit') })
  else
    items.push({ label: `Paste ${name.value}'s link`, icon: 'i-ph-clipboard-text', onSelect: () => emit('add') })
  if (props.friend.keys.length)
    items.push({ label: 'Send a new link', icon: 'i-ph-link', onSelect: () => emit('newLink') })
  else
    items.push({ label: `Send ${name.value} a link`, icon: 'i-ph-link', onSelect: () => emit('invite') })
  return [items, [{ label: 'Remove friend', icon: 'i-ph-trash', color: 'error', onSelect: () => emit('remove') }]]
})
</script>

<template>
  <UCard variant="subtle" :ui="{ body: 'p-3 sm:p-4 space-y-3' }">
    <div class="flex items-start gap-2">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <p class="min-w-0 truncate font-medium text-highlighted" :title="name">
          {{ name }}
        </p>
        <UBadge :color="badge.color" variant="subtle" :label="badge.label" class="max-w-full" />
      </div>
      <UDropdownMenu :items="menu" :content="{ align: 'end' }">
        <UButton icon="i-ph-dots-three-outline" color="neutral" variant="ghost" size="sm" :aria-label="`Actions for ${name}`" />
      </UDropdownMenu>
    </div>

    <div v-if="prompt" class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-elevated/50 px-3 py-2">
      <p class="min-w-0 text-sm text-default">
        {{ prompt.text }}
        <span v-if="prompt.hint" class="text-muted">{{ prompt.hint }}</span>
      </p>
      <UButton
        :label="prompt.label"
        :icon="prompt.icon"
        size="sm"
        :color="prompt.action === 'newLink' ? 'neutral' : 'primary'"
        :variant="prompt.action === 'newLink' ? 'outline' : 'soft'"
        @click="runPrompt"
      />
    </div>

    <!-- You download from them: the peer and its health check. -->
    <div v-if="peer && status" class="space-y-1">
      <p class="flex items-center gap-1.5 text-xs font-medium text-muted">
        <UIcon name="i-ph-arrow-down" class="size-3.5 shrink-0" />
        You download from {{ name }}
      </p>
      <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span class="inline-flex items-center gap-1.5 text-default">
          <UIcon name="i-ph-circle-fill" class="size-2.5 shrink-0" :class="TONE_TEXT[status.tone]" />
          {{ status.label }}
        </span>
        <span v-if="peer.lastSeenAt" class="text-xs text-muted">seen {{ formatTimeAgo(peer.lastSeenAt, now.getTime()) }}</span>
      </p>
      <p class="truncate font-mono text-xs text-muted" :title="peer.url">
        {{ peer.url }}
      </p>
      <p v-if="build" class="text-xs text-muted">
        {{ build }}
      </p>
      <p class="text-xs text-muted tabular-nums">
        Downloaded: {{ trafficSummary(peer.downloaded) }}
      </p>
      <div v-if="problem" class="space-y-1 pt-1">
        <p class="text-xs" :class="TONE_TEXT[status.tone]">
          {{ problem }}
        </p>
        <p v-if="peer.lastError" class="line-clamp-2 font-mono text-[11px] break-words text-dimmed" :title="peer.lastError">
          {{ peer.lastError }}
        </p>
        <UButton
          v-if="peer.lastErrorCode === 'unauthorized'"
          label="Paste new link"
          icon="i-ph-clipboard-text"
          size="xs"
          color="neutral"
          variant="outline"
          @click="emit('pasteNewLink')"
        />
      </div>
    </div>

    <!-- They download from you: the keys you gave them. -->
    <div v-if="friend.keys.length" class="space-y-1.5">
      <p class="flex items-center gap-1.5 text-xs font-medium text-muted">
        <UIcon name="i-ph-arrow-up" class="size-3.5 shrink-0" />
        {{ name }} downloads from you
      </p>
      <div v-for="key in friend.keys" :key="key.id" class="space-y-0.5">
        <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-default">
          <span v-if="showKeyNames" class="text-xs text-muted">{{ keyLabel(key) }}:</span>
          {{ keyUsage(key, keyCreatedAt?.[key.id], now) }}
          <UBadge v-if="key.activeUploads > 0" color="success" variant="subtle" size="sm" :label="`${key.activeUploads} downloading now`" />
        </p>
        <p class="text-xs text-muted tabular-nums">
          Uploaded: {{ trafficSummary(key.uploaded) }}
        </p>
      </div>
      <ULink :to="settingsLink('bandwidth')" class="inline-block text-xs text-muted underline">
        Limits per friend: {{ limitsText }}
      </ULink>
    </div>

    <!-- Name matches jack never applies by itself. -->
    <div
      v-for="key in suggestedKeys"
      :key="key.id"
      class="flex flex-wrap items-center justify-between gap-2 border-t border-default pt-2"
    >
      <p class="min-w-0 text-xs text-muted">
        Key '{{ key.label }}' may be {{ name }}'s. Link it to show it on this card.
      </p>
      <UButton label="Link" icon="i-ph-link-simple" size="xs" color="neutral" variant="outline" :loading="linking" @click="emit('link', [key.id], peer!.id)" />
    </div>
    <div v-if="suggestedPeer" class="flex flex-wrap items-center justify-between gap-2 border-t border-default pt-2">
      <p class="min-w-0 text-xs text-muted">
        Is this the {{ suggestedPeer.name }} you download from?
      </p>
      <UButton
        label="Link"
        icon="i-ph-link-simple"
        size="xs"
        color="neutral"
        variant="outline"
        :loading="linking"
        @click="emit('link', friend.keys.map(k => k.id), suggestedPeer.id)"
      />
    </div>
  </UCard>
</template>
