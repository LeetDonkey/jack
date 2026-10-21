<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'
import type { IntroductionsOverview, IntroPerson, IntroThread } from '~/types/management'

const props = defineProps<{
  // Show the section only while it has requests or messages, e.g. with no friends
  // yet: nobody can be met then, but an earlier conversation stays reachable.
  onlyWithThreads?: boolean
}>()

const { request, extractError } = useManagement()

const { data, error, refresh } = useLazyAsyncData('introductions', () => request<IntroductionsOverview>('introductions'))
const shown = computed(() => !props.onlyWithThreads || (data.value?.threads.length ?? 0) > 0)

const timer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
  timer.value = setInterval(() => void refresh(), 30_000)
})
onBeforeUnmount(() => clearInterval(timer.value))

const busy = ref<string | null>(null)
const actionError = ref<string | null>(null)

async function act(key: string, path: string, body: Record<string, unknown> = {}) {
  busy.value = key
  actionError.value = null
  try {
    await request(path, { method: 'POST', body })
    await refresh()
  }
  catch (err) {
    actionError.value = extractError(err, 'That did not work.')
  }
  finally {
    busy.value = null
  }
}

// Ask-to-connect dialog.
const asking = ref<IntroPerson | null>(null)
const askVia = ref('')
const askMessage = ref('')
function openAsk(person: IntroPerson) {
  asking.value = person
  askVia.value = person.via[0]?.peerId ?? ''
  askMessage.value = ''
}
async function sendAsk() {
  if (!asking.value)
    return
  await act(`ask-${asking.value.id}`, 'introductions/requests', {
    personId: asking.value.id,
    viaPeerId: askVia.value,
    ...(askMessage.value.trim() ? { message: askMessage.value.trim() } : {}),
  })
  if (!actionError.value)
    asking.value = null
}

const drafts = reactive<Record<string, string>>({})
function draftBody(thread: IntroThread) {
  const text = drafts[thread.requestId]?.trim()
  return text ? { message: text } : {}
}
async function answer(thread: IntroThread, verb: 'accept' | 'decline') {
  await act(`${verb}-${thread.requestId}`, `introductions/requests/${thread.requestId}/${verb}`, draftBody(thread))
  if (!actionError.value)
    drafts[thread.requestId] = ''
}
async function sendMessage(thread: IntroThread) {
  const text = drafts[thread.requestId]?.trim()
  if (!text)
    return
  await act(`msg-${thread.requestId}`, `introductions/requests/${thread.requestId}/messages`, { text })
  if (!actionError.value)
    drafts[thread.requestId] = ''
}

const stateBadge: Record<IntroThread['state'], { color: 'neutral' | 'warning' | 'success' | 'error', label: string }> = {
  pending: { color: 'warning', label: 'Waiting for an answer' },
  accepted: { color: 'neutral', label: 'Accepted, connecting…' },
  connected: { color: 'success', label: 'Connected' },
  declined: { color: 'error', label: 'Declined' },
}

function threadBadge(thread: IntroThread) {
  if (thread.direction === 'incoming' && thread.state === 'pending')
    return { color: 'primary' as const, label: 'Wants to connect' }
  // Connected once, but no longer one of your friends (you removed them).
  if (thread.ended)
    return { color: 'neutral' as const, label: 'Ended' }
  return stateBadge[thread.state]
}

const threads = computed(() => [...(data.value?.threads ?? [])].sort((a, b) => {
  const rank = (t: IntroThread) => (t.direction === 'incoming' && t.state === 'pending' ? 0 : t.ended ? 3 : t.state === 'connected' || t.state === 'declined' ? 2 : 1)
  return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)
}))

// Friends of friends see you only through a friend who introduces. Say they see
// you only when one did at the last sync (`introducers` is null before the first).
const visibility = computed<'hidden' | 'seen' | 'noIntroducers' | 'unknown'>(() => {
  const me = data.value?.me
  if (!me?.discoverable || !me.name)
    return 'hidden'
  if (me.introducers == null)
    return 'unknown'
  return me.introducers > 0 ? 'seen' : 'noIntroducers'
})

// What is missing before you can ask or accept. The name friends of friends see
// falls back to the name friends see, so `me.name` is null exactly when both are
// empty; any other entry is the address friends use. Both are set under Your
// public address.
const setup = computed(() => {
  const me = data.value?.me
  if (!me || me.ready)
    return null
  const needsName = !me.name
  const needsAddress = me.missing.length > (needsName ? 1 : 0)
  let title = 'To ask or accept, set the address friends use.'
  if (needsName && needsAddress)
    title = 'To ask or accept, set the name friends see and the address friends use.'
  else if (needsName)
    title = 'To ask or accept, set the name friends see.'
  let label = 'Set up your public address'
  if (!needsAddress)
    label = 'Set the name friends see'
  else if (!needsName)
    label = 'Set the address friends use'
  const actions: ButtonProps[] = [{ color: 'warning', variant: 'outline', label, to: settingsLink('public-address') }]
  return { title, actions }
})
</script>

<template>
  <section v-if="shown" class="space-y-3">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-sm font-medium text-highlighted">
        Friends of friends
      </h2>
      <UButton label="Refresh" icon="i-ph-arrows-clockwise" size="xs" color="neutral" variant="ghost" :loading="busy === 'sync'" @click="act('sync', 'introductions/sync')" />
    </div>

    <LoadErrorAlert v-if="error && !data" :error="error" :retry="refresh" what="friends of friends" />

    <template v-else-if="data">
      <UAlert
        v-if="setup"
        color="warning"
        variant="soft"
        icon="i-ph-info"
        :title="setup.title"
        :actions="setup.actions"
      />
      <p class="text-xs text-muted">
        <template v-if="visibility === 'seen'">
          Friends of your friends see you as <span class="font-medium text-default">{{ data.me.name }}</span>.
        </template>
        <template v-else-if="visibility === 'noIntroducers'">
          None of your friends introduce right now, so friends of friends can't see you yet. Once one does, you show up as
          <span class="font-medium text-default">{{ data.me.name }}</span>.
        </template>
        <template v-else-if="visibility === 'unknown'">
          Friends of your friends see you as <span class="font-medium text-default">{{ data.me.name }}</span> when one of your friends introduces you.
        </template>
        <template v-else>
          You are not visible to friends of friends.
        </template>
        <ULink :to="settingsLink('friends-of-friends')" class="underline">
          Change
        </ULink>
      </p>
      <UAlert v-if="actionError" color="error" variant="soft" icon="i-ph-warning" :title="actionError" />

      <UCard v-for="thread in threads" :key="thread.requestId" variant="subtle" :ui="{ body: 'p-3 space-y-2' }">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="font-medium text-default">
            {{ thread.peerName }}
            <span class="text-xs font-normal text-muted">via {{ thread.viaName }}</span>
          </p>
          <UBadge :color="threadBadge(thread).color" variant="subtle" :label="threadBadge(thread).label" />
        </div>

        <div v-if="thread.messages.length" class="space-y-1">
          <p
            v-for="(m, i) in thread.messages"
            :key="i"
            class="rounded-md px-2 py-1 text-sm"
            :class="m.from === 'me' ? 'ml-8 bg-primary/10 text-default' : m.from === 'them' ? 'mr-8 bg-elevated text-default' : 'text-xs text-error'"
          >
            {{ m.text }}
            <span class="block text-[10px] text-dimmed">{{ m.from === 'me' ? 'You' : m.from === 'them' ? thread.peerName : 'jack' }} · {{ formatAgo(m.at) }}</span>
          </p>
        </div>

        <div v-if="thread.state !== 'connected' && thread.state !== 'declined'" class="flex flex-wrap items-end gap-2">
          <UTextarea v-model="drafts[thread.requestId]" :rows="1" autoresize placeholder="Write a message (optional)" class="min-w-0 flex-1" maxlength="2000" />
          <template v-if="thread.direction === 'incoming' && thread.state === 'pending'">
            <UButton label="Decline" color="neutral" variant="ghost" :loading="busy === `decline-${thread.requestId}`" @click="answer(thread, 'decline')" />
            <UButton label="Accept" icon="i-ph-handshake" :disabled="!data.me.ready" :loading="busy === `accept-${thread.requestId}`" @click="answer(thread, 'accept')" />
          </template>
          <UButton v-else label="Send" icon="i-ph-paper-plane-tilt" variant="soft" :disabled="!drafts[thread.requestId]?.trim()" :loading="busy === `msg-${thread.requestId}`" @click="sendMessage(thread)" />
        </div>

        <p class="text-[11px] text-dimmed">
          Safety code {{ thread.safetyCode }}. The same code at {{ thread.peerName }} proves nobody in between swapped your keys.
          <template v-if="thread.ended">
            {{ thread.peerName }} is no longer one of your friends. You can ask to connect again.
          </template>
          <template v-else-if="thread.state === 'connected'">
            {{ thread.peerName }} is now one of your friends.
          </template>
        </p>
      </UCard>

      <p v-if="data.people.length === 0" class="text-sm text-muted">
        Nobody to meet yet. Once a friend introduces you to their friends, the ones who chose to be found show up here.
      </p>
      <UCard v-for="person in data.people" :key="person.id" variant="subtle" :ui="{ body: 'p-3' }">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="font-medium text-default">
              {{ person.name }}
            </p>
            <p class="text-xs text-muted">
              Friend of {{ person.via.map(v => v.name).join(', ') }}
            </p>
          </div>
          <UBadge v-if="person.status === 'connected'" color="success" variant="subtle" label="Connected" />
          <UBadge v-else-if="person.status === 'requested'" color="neutral" variant="subtle" label="Requested" />
          <UButton v-else label="Ask to connect" icon="i-ph-hand-waving" size="sm" variant="soft" :disabled="!data.me.ready" @click="openAsk(person)" />
        </div>
      </UCard>
    </template>

    <!-- jack asks each friend for their directory, which can take a while when one
         doesn't answer. -->
    <p v-else class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UModal :open="asking != null" :title="asking ? `Ask ${asking.name} to connect` : ''" @update:open="(open: boolean) => { if (!open) asking = null }">
      <template #body>
        <div v-if="asking" class="space-y-3">
          <p class="text-sm text-muted">
            {{ asking.name }} sees your name and your message. Your address is only sent if they accept.
          </p>
          <UFormField v-if="asking.via.length > 1" label="Through">
            <USelect v-model="askVia" :items="asking.via.map(v => ({ label: v.name, value: v.peerId }))" class="w-full" />
          </UFormField>
          <UFormField label="Message" hint="optional">
            <UTextarea v-model="askMessage" :rows="3" maxlength="2000" class="w-full" placeholder="Hi, I'm a friend of …" />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="() => { asking = null }" />
            <UButton label="Send request" icon="i-ph-paper-plane-tilt" :loading="busy === `ask-${asking.id}`" @click="sendAsk" />
          </div>
        </div>
      </template>
    </UModal>
  </section>
</template>
