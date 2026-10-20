<script setup lang="ts">
import type { ApiKey, Friend, FriendPeer, FriendsSnapshot, PeerHealth, PeerInput, PeerItem } from '~/types/management'

const { request, extractError } = useManagement()
const toast = useToast()
const route = useRoute()
const router = useRouter()

const { data, pending, error, refresh } = await useAsyncData('friends', () => request<FriendsSnapshot>('friends'))
// When each key was created, which /friends leaves out: it tells "Never used" from
// "Not connected since" for keys older than jack's record of key use, and several
// keys of one friend apart.
const { data: apiKeys, refresh: refreshKeys } = useLazyAsyncData('friends:api-keys', () => request<ApiKey[]>('api-keys'))
const keyCreatedAt = computed<Record<number, string>>(() => Object.fromEntries((apiKeys.value ?? []).map(key => [key.id, key.createdAt])))

// The clock relative times are shown against, moved on by every refresh.
const now = ref(new Date())
const checking = ref(false)

// Once the list is on screen, reloads go around useAsyncData, whose failed
// refresh empties `data`: while jack is away the last list stays, marked as last
// known. Until then a failure lands in `error`, and LoadErrorAlert tries again.
// `loadSeq` drops an answer that a newer load or Check now has overtaken.
let loadSeq = 0
async function loadFriends(): Promise<void> {
  if (!data.value)
    return refresh()
  const seq = ++loadSeq
  try {
    const snapshot = await request<FriendsSnapshot>('friends')
    if (seq === loadSeq)
      data.value = snapshot
  }
  catch {
    // The next poll, or jack's return, tries again.
  }
}

async function reload() {
  await Promise.all([loadFriends(), refreshKeys()])
  now.value = new Date()
}

const { overview, jackDown } = useOverview()

// Health is checked every 5 minutes and traffic is flushed every 30 seconds, so a
// slow poll is enough. The overview stream says when a check changed something.
// Nothing is asked while jack is away; its return reloads the list.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = new Date()
    if (!checking.value && !jackDown.value)
      void loadFriends()
  }, 30_000)
})
onBeforeUnmount(() => clearInterval(timer))

// A list on screen is reloaded at once (without one, LoadErrorAlert does that).
// Keys that failed to load while jack was away load again too.
onJackBack(() => {
  if (data.value && !checking.value) {
    void loadFriends()
    now.value = new Date()
  }
  if (apiKeys.value === undefined)
    void refreshKeys()
})

const healthSignature = computed(() => {
  const items = overview.value?.peers.items as Array<{ id: string, health?: PeerHealth }> | undefined
  return items?.map(peer => `${peer.id}:${peer.health?.online}:${peer.health?.lastErrorCode}`).join('|') ?? ''
})
watch(healthSignature, (next, prev) => {
  if (prev && next !== prev && !checking.value)
    void loadFriends()
})

// Asks every friend's jack now; the answer can take up to 30 s per friend that doesn't answer.
async function checkNow() {
  if (checking.value)
    return
  checking.value = true
  try {
    const snapshot = await request<FriendsSnapshot>('friends/check', { method: 'POST' })
    loadSeq++
    data.value = snapshot
    now.value = new Date()
  }
  catch (err) {
    toast.add({ color: 'error', icon: 'i-ph-warning', title: extractError(err, 'Could not check your friends.') })
  }
  finally {
    checking.value = false
  }
}

const friends = computed(() => data.value?.friends ?? [])
const unlinked = computed(() => data.value?.unlinked ?? { peers: [], keys: [] })
const unlinkedCount = computed(() => unlinked.value.peers.length + unlinked.value.keys.length)
const looseKeyNames = computed<Record<number, string | null>>(() => Object.fromEntries(unlinked.value.keys.map(key => [key.id, key.name])))
const peerNames = computed<Record<string, string>>(() => Object.fromEntries((data.value?.peers ?? []).map(peer => [peer.id, peer.name])))
const cardNames = computed<Record<string, string>>(() => Object.fromEntries(friends.value.map(friend => [friend.key, friend.name])))
// Friends you download from, as targets for "Link to…".
const linkTargets = computed(() => friends.value
  .filter(friend => friend.peer)
  .map(friend => ({ label: friend.name, value: friend.peer!.id })))

// ── Invite and add ──────────────────────────────────────────────────────────
const inviteOpen = ref(false)
const invite = ref<{ name?: string, peerId?: string | null, replaceKey?: { id: number, name: string | null } | null }>({})
const addOpen = ref(false)
const add = ref<{ name?: string, peer?: PeerItem | null, start?: 'paste' | 'form', linkKeyIds?: number[] }>({})

function openInvite(options: typeof invite.value = {}) {
  invite.value = options
  inviteOpen.value = true
}
function openAdd(options: typeof add.value = {}) {
  add.value = options
  addOpen.value = true
}

// One dialog hands over to the other once it has closed.
function inviteAfterAdd(saved: { name: string, peerId: string }) {
  void nextTick(() => openInvite({ name: saved.name, peerId: saved.peerId }))
}
function addAfterInvite(created: { name: string, keyId: number }) {
  void nextTick(() => openAdd({ name: created.name, start: 'paste', linkKeyIds: [created.keyId] }))
}

// The stored peer, with its key and headers as refs, for an edit or a rename.
async function loadPeer(id: string): Promise<PeerItem> {
  const { peers } = await request<{ peers: PeerItem[] }>('config/peers')
  const peer = peers.find(p => p.id === id)
  if (!peer)
    throw new Error('This friend is gone. The list is up to date again.')
  if (peer.apiKey === undefined)
    throw new Error('Friends can only be changed in jack\'s config file on this install.')
  return peer
}

async function openPeerEdit(friend: Friend, start: 'paste' | 'form') {
  if (friend.peer)
    await openPeerEditById(friend.peer.id, start)
}

async function openPeerEditById(id: string, start: 'paste' | 'form') {
  try {
    openAdd({ peer: await loadPeer(id), start })
  }
  catch (err) {
    toast.add({ color: 'error', icon: 'i-ph-warning', title: extractError(err, 'Could not load this friend.') })
    void reload()
  }
}

function sendNewLink(friend: Friend) {
  const key = keyToReplace(friend.keys)
  openInvite({ name: friend.name, peerId: friend.peer?.id ?? null, replaceKey: key ? { id: key.id, name: key.name } : null })
}

// ?action=invite or ?action=add opens that dialog, and ?action=paste&peer=<id> opens
// Paste new link for that friend (links from the dashboard and elsewhere).
onMounted(() => {
  const action = route.query.action
  if (action !== 'invite' && action !== 'add' && action !== 'paste')
    return
  const { action: _action, peer: peerId, ...query } = route.query
  void router.replace({ query })
  if (action === 'invite') {
    openInvite()
  }
  else if (action === 'add') {
    openAdd()
  }
  else if (typeof peerId === 'string' && (data.value?.peers ?? []).some(peer => peer.id === peerId)) {
    void openPeerEditById(peerId, 'paste')
  }
})

// ── Link ────────────────────────────────────────────────────────────────────
// What is being linked: a card's key or `key:<id>` for a row below.
const linking = ref<string | null>(null)

async function link(keyIds: number[], peerId: string, busy: string) {
  if (linking.value || !keyIds.length)
    return
  linking.value = busy
  try {
    await Promise.all(keyIds.map(id => request(`api-keys/${id}`, { method: 'PATCH', body: { peerId } })))
    toast.add({ color: 'success', icon: 'i-ph-check-circle', title: `Linked to ${peerNames.value[peerId] ?? 'your friend'}.` })
    await reload()
  }
  catch (err) {
    toast.add({ color: 'error', icon: 'i-ph-warning', title: extractError(err, 'Could not link the key.') })
    // Some keys may have been linked before the failure.
    void reload()
  }
  finally {
    linking.value = null
  }
}

// ── Rename ──────────────────────────────────────────────────────────────────
const renameOpen = ref(false)
const renameTarget = ref<Friend | null>(null)
const renameState = reactive({ name: '' })
const renaming = ref(false)
const renameError = ref<string | null>(null)

function openRename(friend: Friend) {
  renameTarget.value = friend
  renameState.name = friend.name
  renameError.value = null
  renameOpen.value = true
}

function validateRename(s: typeof renameState) {
  return s.name.trim() ? [] : [{ name: 'name', message: 'Enter a name for this friend.' }]
}

async function saveRename() {
  const friend = renameTarget.value
  const name = renameState.name.trim()
  if (!friend || !name || renaming.value)
    return
  renaming.value = true
  renameError.value = null
  try {
    if (friend.peer) {
      const peer = await loadPeer(friend.peer.id)
      const body: PeerInput = { name, url: peer.url, apiKey: peer.apiKey! }
      if (peer.headers && Object.keys(peer.headers).length)
        body.headers = peer.headers
      // A new name doesn't depend on their jack answering.
      await request(`config/peers/${friend.peer.id}`, { method: 'PATCH', body, query: { force: 'true' } })
    }
    // Keys named after the friend follow the new name; a key with its own name keeps it.
    const keys = friend.peer ? friend.keys.filter(key => sameName(key.name, friend.name)) : friend.keys
    await Promise.all(keys.map(key => request(`api-keys/${key.id}`, { method: 'PATCH', body: { name } })))
    renameOpen.value = false
    await reload()
  }
  catch (err) {
    renameError.value = extractError(err, 'Could not rename this friend.')
    // The peer or some keys may have been renamed before the failure.
    void reload()
  }
  finally {
    renaming.value = false
  }
}

// ── Remove ──────────────────────────────────────────────────────────────────
const removeOpen = ref(false)
const removeTarget = ref<Friend | null>(null)

function openRemove(friend: Friend) {
  removeTarget.value = friend
  removeOpen.value = true
}
// The friend's other addresses go too when you stop downloading from them.
const removeAddresses = computed(() => {
  const key = removeTarget.value?.key
  return key ? unlinked.value.peers.filter(peer => peer.sameAs === key) : []
})

// One of a friend's several keys.
const revokeOpen = ref(false)
const revokeTarget = ref<{ friend: Friend, keyId: number } | null>(null)

function openRevoke(friend: Friend, keyId: number) {
  revokeTarget.value = { friend, keyId }
  revokeOpen.value = true
}

// A second address for a jack that already has a card.
const addressTarget = ref<(FriendPeer & { sameAs: string }) | null>(null)
const lastAddress = ref<(FriendPeer & { sameAs: string }) | null>(null)
watch(addressTarget, (peer) => {
  if (peer)
    lastAddress.value = peer
})
const removingAddress = ref(false)
const addressError = ref<string | null>(null)
const addressOpen = computed({
  get: () => addressTarget.value !== null,
  set: (value) => {
    if (!value && !removingAddress.value) {
      addressTarget.value = null
      addressError.value = null
    }
  },
})

async function removeAddress() {
  const peer = addressTarget.value
  if (!peer || removingAddress.value)
    return
  removingAddress.value = true
  addressError.value = null
  try {
    await request(`config/peers/${peer.id}`, { method: 'DELETE' })
    addressTarget.value = null
    await reload()
  }
  catch (err) {
    addressError.value = extractError(err, 'Could not remove this address.')
  }
  finally {
    removingAddress.value = false
  }
}

const unlinkedOpen = ref(false)
</script>

<template>
  <UDashboardPanel id="friends">
    <template #header>
      <UDashboardNavbar title="Friends">
        <template #right>
          <UButton
            icon="i-ph-arrows-clockwise"
            color="neutral"
            variant="ghost"
            :loading="checking"
            aria-label="Check now"
            @click="checkNow"
          >
            <span class="hidden sm:inline">Check now</span>
          </UButton>
          <UButton icon="i-ph-clipboard-text" color="neutral" variant="outline" aria-label="Add a friend" @click="openAdd()">
            <span class="hidden sm:inline">Add a friend</span>
          </UButton>
          <UButton icon="i-ph-link" label="Invite a friend" @click="openInvite()" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <LoadErrorAlert v-if="error && !data" :error="error" :retry="reload" />

      <p v-else-if="pending && !data" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <div v-else-if="data" class="space-y-8">
        <!-- While jack is away the list stays as jack last sent it, greyed like the
             dashboard's, and the layout's notice says why. -->
        <section class="space-y-3 transition-[filter]" :class="{ grayscale: jackDown }">
          <p v-if="jackDown" role="status" class="text-xs text-muted">
            Last known. This list updates once jack is back.
          </p>

          <UCard v-if="friends.length === 0" variant="subtle">
            <div class="flex flex-col items-center gap-3 py-6 text-center">
              <UIcon name="i-ph-users-three" class="size-8 text-dimmed" />
              <div class="space-y-1">
                <p class="text-sm font-medium text-highlighted">
                  No friends yet.
                </p>
                <p class="text-sm text-muted">
                  Send a friend an invite link so they can download from you, or paste the link a friend sent you.
                </p>
              </div>
              <div class="flex flex-wrap justify-center gap-2">
                <UButton label="Invite a friend" icon="i-ph-link" @click="openInvite()" />
                <UButton label="Add a friend" icon="i-ph-clipboard-text" color="neutral" variant="outline" @click="openAdd()" />
              </div>
            </div>
          </UCard>

          <FriendCard
            v-for="friend in friends"
            :key="friend.key"
            :friend="friend"
            :limits="data.limits"
            :key-created-at="keyCreatedAt"
            :loose-key-names="looseKeyNames"
            :peer-names="peerNames"
            :now="now"
            :linking="linking === friend.key"
            @invite="openInvite({ name: friend.name, peerId: friend.peer?.id ?? null })"
            @new-link="sendNewLink(friend)"
            @add="openAdd({ name: friend.name, start: 'paste', linkKeyIds: friend.keys.map(key => key.id) })"
            @paste-new-link="openPeerEdit(friend, 'paste')"
            @rename="openRename(friend)"
            @edit="openPeerEdit(friend, 'form')"
            @remove="openRemove(friend)"
            @revoke-key="(keyId) => openRevoke(friend, keyId)"
            @link="(keyIds, peerId) => link(keyIds, peerId, friend.key)"
          />
        </section>

        <IntroductionsPanel />

        <section v-if="unlinkedCount" class="space-y-2">
          <UCollapsible v-model:open="unlinkedOpen">
            <UButton
              variant="link"
              color="neutral"
              class="px-0 font-medium"
              :label="`Not linked to a friend (${unlinkedCount})`"
              :icon="unlinkedOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
            />
            <template #content>
              <div class="space-y-2 pt-2">
                <p class="text-xs text-muted">
                  Keys and addresses that aren't on a friend's card. Link a key to the friend whose jack uses it, so both directions show together.
                </p>

                <UCard v-for="key in unlinked.keys" :key="`key:${key.id}`" variant="subtle" :ui="{ body: 'p-3 space-y-2' }">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-default">
                        <UIcon name="i-ph-key" class="mr-1 size-3.5 align-[-2px] text-muted" />
                        {{ key.name?.trim() || `Key #${key.id}` }}
                      </p>
                      <p class="text-xs text-muted">
                        {{ keyUsage(key, keyCreatedAt[key.id], now) }} · Uploaded {{ formatBytes(key.uploaded.month) }} in 30 days
                      </p>
                    </div>
                    <USelect
                      :model-value="undefined"
                      :items="linkTargets"
                      :placeholder="linkTargets.length ? 'Link to…' : 'No friend to link to'"
                      :disabled="!linkTargets.length"
                      :loading="linking === `key:${key.id}`"
                      size="sm"
                      class="w-full sm:w-48"
                      :aria-label="`Link ${key.name ?? `key #${key.id}`} to a friend`"
                      @update:model-value="(peerId) => peerId && link([key.id], String(peerId), `key:${key.id}`)"
                    />
                  </div>
                  <p v-if="key.suggestedPeerId && peerNames[key.suggestedPeerId]" class="text-xs text-muted">
                    Looks like {{ peerNames[key.suggestedPeerId] }}.
                    <UButton
                      variant="link"
                      size="xs"
                      label="Link"
                      class="p-0 align-baseline"
                      :disabled="linking !== null"
                      @click="link([key.id], key.suggestedPeerId!, `key:${key.id}`)"
                    />
                  </p>
                </UCard>

                <UCard v-for="peer in unlinked.peers" :key="`peer:${peer.id}`" variant="subtle" :ui="{ body: 'p-3' }">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-default">
                        {{ peer.name }}
                      </p>
                      <p class="truncate font-mono text-xs text-muted" :title="peer.url">
                        {{ peer.url }}
                      </p>
                      <p class="text-xs text-muted">
                        Another address for {{ cardNames[peer.sameAs] ?? 'a friend' }}. jack uses the one that answers.
                      </p>
                    </div>
                    <UButton label="Remove this address" size="xs" color="neutral" variant="outline" @click="() => { addressTarget = peer }" />
                  </div>
                </UCard>

                <ULink :to="settingsLink('other-keys')" class="inline-block text-xs text-muted underline">
                  API keys for other tools are under Settings -> Advanced
                </ULink>
              </div>
            </template>
          </UCollapsible>
        </section>

        <p class="text-xs text-muted">
          Each friend's jack is checked every 5 minutes. Daily totals reset at midnight in jack's time zone and count from when jack started tracking traffic.
        </p>
      </div>
    </template>
  </UDashboardPanel>

  <InviteFriendModal
    v-model:open="inviteOpen"
    :name="invite.name"
    :peer-id="invite.peerId"
    :replace-key="invite.replaceKey"
    :friends="friends"
    @created="reload"
    @add="addAfterInvite"
  />

  <AddFriendModal
    v-model:open="addOpen"
    :name="add.name"
    :peer="add.peer"
    :start="add.start"
    :link-key-ids="add.linkKeyIds"
    @saved="reload"
    @invite="inviteAfterAdd"
  />

  <RemoveFriendModal
    v-model:open="removeOpen"
    :friend="removeTarget"
    :other-addresses="removeAddresses"
    :key-created-at="keyCreatedAt"
    @removed="reload"
  />

  <RevokeKeyModal
    v-model:open="revokeOpen"
    :friend="revokeTarget?.friend ?? null"
    :key-id="revokeTarget?.keyId ?? null"
    :key-created-at="keyCreatedAt"
    @revoked="reload"
  />

  <UModal v-model:open="renameOpen" :title="`Rename ${renameTarget?.name ?? 'friend'}`" :dismissible="!renaming">
    <template #body>
      <UForm :state="renameState" :validate="validateRename" class="space-y-4" @submit="saveRename">
        <UFormField name="name" label="Name" description="How they show up on your Friends page and in your lists. Keys named after them are renamed too." required>
          <UInput v-model="renameState.name" :maxlength="100" placeholder="e.g. Alice" autofocus class="w-full" />
        </UFormField>
        <UAlert v-if="renameError" color="error" variant="soft" icon="i-ph-warning" :title="renameError" />
        <div class="flex justify-end gap-2 pt-2">
          <UButton label="Cancel" color="neutral" variant="ghost" :disabled="renaming" @click="() => { renameOpen = false }" />
          <UButton type="submit" label="Save changes" :loading="renaming" />
        </div>
      </UForm>
    </template>
  </UModal>

  <UModal v-model:open="addressOpen" title="Remove this address?" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        jack stops using <span class="font-mono text-xs break-all">{{ lastAddress?.url }}</span> for
        {{ cardNames[lastAddress?.sameAs ?? ''] ?? 'this friend' }}. Their other address stays.
      </p>
      <UAlert v-if="addressError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="addressError" />
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="removingAddress" @click="() => { addressOpen = false }" />
      <UButton label="Remove" color="error" :loading="removingAddress" @click="removeAddress" />
    </template>
  </UModal>
</template>
