<script setup lang="ts">
import type { SetupRequiredState } from '~/composables/useSetupStatus'
import type { ActivityDownload, ActivityOverview, OverviewPeer } from '~/types/activity'
import type { AttentionCounts } from '~/utils/attention'

const props = withDefaults(defineProps<{
  overview: ActivityOverview
  // The required setup steps (SetupChecklist). The green all-clear needs `done`:
  // with steps open, "no problems" would mislead even when nothing is failing, and
  // while the answer is unknown or a server is still connecting it would be a guess.
  // With only the restart left (`restart`), the restart banner says it all.
  setupState?: SetupRequiredState
  // Whether config/downloads exists; null when unknown.
  downloadsOn?: boolean | null
  // The user said "I only share" on the setup card.
  shareOnly?: boolean
  // What the setup card shows right now, so it isn't said twice: the servers whose
  // registration result it quotes, whether it asks for a server that receives
  // downloads, and whether it shows a problem (a failed step or folder check), which
  // rules out "Nothing is failing".
  setupServerIds?: string[]
  setupAsksForReceiver?: boolean
  setupShowsProblem?: boolean
  // The page's ticking clock, so a paused indexer drops off when its pause ends.
  now?: number
  // The overview stopped updating (jack isn't answering). The layout says so; this
  // panel then makes no claim that nothing is failing.
  stale?: boolean
}>(), { setupState: 'done', downloadsOn: null, shareOnly: false, setupServerIds: () => [], setupAsksForReceiver: false, setupShowsProblem: false, now: () => Date.now(), stale: false })

// How many example rows to list before collapsing the rest into "and N more".
const PREVIEW = 3

// A friend is a problem when their last health check failed (every 5 minutes), or,
// before the first check, when jack couldn't connect at startup. One still
// connecting with no error yet is transient, not something to act on.
function friendIsDown(peer: OverviewPeer): boolean {
  const online = peer.health?.online ?? null
  return online === false || (online === null && !peer.initialized && Boolean(peer.initializationError))
}

interface FriendProblem {
  id: string
  name: string
  message: string
  // The error behind it, when the message doesn't already say it.
  detail: string | null
  action: string
  to: string
}

function friendProblem(peer: OverviewPeer): FriendProblem {
  const health = peer.health
  const base = { id: peer.id, name: peer.name, detail: health?.lastError ?? peer.initializationError ?? null, action: 'See friends', to: '/friends' }
  switch (health?.online === false ? health.lastErrorCode : null) {
    case 'unauthorized':
      return { ...base, detail: null, action: 'Paste new link', to: `/friends?action=paste&peer=${encodeURIComponent(peer.id)}`, message: `${peer.name}'s jack rejected your key. They may have revoked it or sent you a new link.` }
    case 'forbidden':
      return { ...base, detail: null, message: `${peer.name}'s jack is blocking you, possibly banned after failed attempts.` }
    case 'incompatible':
      return { ...base, detail: null, message: `${peer.name} needs a newer jack.` }
  }
  const since = formatClockOrDay(health?.offlineSince)
  return { ...base, message: since ? `${peer.name} has been offline since ${since}.` : `Can't reach ${peer.name}.` }
}

const downFriends = computed(() => props.overview.peers.items.filter(friendIsDown).map(friendProblem))
const unreachableServers = computed(() => props.overview.servers.items.filter(s => !s.initialized && s.initializationError))
const stuckImports = computed(() => props.overview.downloads.importQueued)
const failed = computed(() => props.overview.downloads.failed)
const failedCount = computed(() => props.overview.downloads.byStatus.failed ?? 0)
function failureTitle(download: ActivityDownload): string | undefined {
  const plain = plainDownloadError(download)
  if (!plain)
    return download.error ?? undefined
  const detail = downloadErrorDetail(download)
  return detail ? `${plain}\n${detail}` : plain
}
const queuedCount = computed(() => props.overview.downloads.byStatus.import_queued ?? 0)
// The usual cause: the *arr sees jack's Completed folder under another path.
const importHint = computed(() =>
  `Radarr/Sonarr hasn't imported ${queuedCount.value === 1 ? 'it' : 'these'} yet. Usually it can't see the completed folder at the same path. Check Radarr/Sonarr -> Activity -> Queue.`)
// Live integrity warnings: only for in-flight/queued transfers — failed rows
// already carry their own error message below. The headline count uses the true
// backend total (`mismatched`); the rows are example detail from the capped lists.
const mismatchCount = computed(() => props.overview.downloads.mismatched)
const mismatches = computed(() =>
  [...props.overview.downloads.active, ...props.overview.downloads.importQueued]
    .filter(d => d.expectedBytesMismatch))

// Friends to download from, but no server that receives downloads. Sharing only is
// a valid setup, so this is information, unless downloads are on: then nothing can
// land anywhere and it counts as an issue.
const onlyShares = computed(() =>
  !props.shareOnly
  && !props.setupAsksForReceiver
  && props.overview.peers.total > 0
  && props.overview.servers.sources > 0
  && props.overview.servers.destinations === 0)
const onlySharesIsIssue = computed(() => onlyShares.value && props.downloadsOn === true)

interface RegistrationProblem {
  id: string
  name: string
  // jack's own sentence, which names the server and the fix. `step` and `error`
  // only build a line when jack sent none.
  message: string | null
  step: 'a download client' | 'an indexer' | null
  error: string | null
  // The setting the message names, such as the address Radarr/Sonarr use.
  fix: ReturnType<typeof registrationFix>
}

// A part jack couldn't add because the *arr couldn't connect to jack's address:
// the *arr's raw error doesn't name the setting, but the address is what to check.
const ADDRESS_FIX = { section: 'internal-url', label: 'Change the address' } as const

// jack's own setup inside each reachable Radarr/Sonarr: a part jack couldn't add, or
// the *arr's test of jack failing. A server jack can't reach has its row above.
const registrationProblems = computed(() => props.overview.servers.items.flatMap((server): RegistrationProblem[] => {
  const registration = server.registration
  if (!registration || !server.initialized || props.setupServerIds.includes(server.id))
    return []
  const fix = registrationFix(registration) ?? (registrationAddressProblem(registration) ? ADDRESS_FIX : null)
  const problem = { id: server.id, name: server.name, message: registration.message, fix }
  if (registration.downloadClient.status === 'failed')
    return [{ ...problem, step: 'a download client', error: registration.downloadClient.error ?? null }]
  if (registration.indexer.status === 'failed')
    return [{ ...problem, step: 'an indexer', error: registration.indexer.error ?? null }]
  if (registration.clientTest === 'failed' || registration.indexerTest === 'failed')
    return [{ ...problem, message: problem.message ?? `${server.name} couldn't reach jack.`, step: null, error: null }]
  return []
}))

// Radarr/Sonarr skip jack's indexer for now after failures, so friends' releases
// don't show up in them until the pause ends. A server with a problem row above
// has its fix there.
const pausedIndexers = computed(() => props.overview.servers.items.flatMap((server) => {
  const pause = server.initialized ? indexerPauseText(server, server.registration, props.now) : null
  if (!pause || props.setupServerIds.includes(server.id) || registrationProblems.value.some(p => p.id === server.id))
    return []
  return [{ id: server.id, ...pause }]
}))

// Each unreachable connector and each server jack isn't set up in is its own
// fixable thing; download problems collapse to one line each. The counts drive the
// heading and its badge: red only for something broken, and no "issues" at all
// when every row resolves by itself.
const counts = computed((): AttentionCounts => ({
  errors: downFriends.value.length
    + unreachableServers.value.length
    + registrationProblems.value.length
    + (failedCount.value ? 1 : 0),
  warnings: (queuedCount.value ? 1 : 0)
    + (mismatchCount.value ? 1 : 0)
    + (onlySharesIsIssue.value ? 1 : 0),
  notices: pausedIndexers.value.length,
}))
const issueCount = computed(() => counts.value.errors + counts.value.warnings + counts.value.notices)
const heading = computed(() => attentionHeading(counts.value))

const nothingConfigured = computed(() => props.overview.peers.total === 0 && props.overview.servers.total === 0)

const allClearTitle = computed(() =>
  `No problems. ${plural(props.overview.peers.online ?? props.overview.peers.initialized, 'friend')} online, ${props.overview.servers.initialized} Radarr/Sonarr connected.`)

// Starts open on every visit, and opens again when a new issue arrives.
const open = ref(true)
watch(issueCount, (count, previous) => {
  if (count > previous)
    open.value = true
})

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
</script>

<template>
  <div class="space-y-4">
    <!-- Something needs doing, or is worth knowing. While jack isn't answering it
         is what jack last sent, marked like the dashboard's other sections. -->
    <UCard v-if="heading" variant="subtle" class="transition-[filter]" :class="{ grayscale: stale }" :ui="{ body: '!p-0' }">
      <UCollapsible v-model:open="open" :ui="{ root: 'group' }">
        <button type="button" class="flex w-full items-center gap-3 px-4 py-3.5 text-left">
          <UIcon name="i-ph-caret-down" class="size-4 text-muted transition-transform group-data-[state=closed]:-rotate-90" />
          <span class="text-sm font-semibold text-highlighted">
            {{ heading.title }}<span v-if="stale" class="font-normal text-muted"> · last known</span>
          </span>
          <UBadge class="ml-auto" :color="heading.color" variant="subtle" :label="heading.badge" />
        </button>

        <template #content>
          <div class="divide-y divide-default border-t border-default">
            <!-- Friends whose last health check failed -->
            <div v-for="friend in downFriends" :key="`peer-${friend.id}`" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-warning-circle" class="mt-0.5 size-4 shrink-0 text-error" />
              <div class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                <p class="text-sm break-words text-default">
                  {{ friend.message }}
                </p>
                <p v-if="friend.detail" class="mt-1 font-mono text-xs break-words text-error">
                  {{ friend.detail }}
                </p>
              </div>
              <UButton :to="friend.to" :label="friend.action" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Unreachable Radarr/Sonarr -->
            <div v-for="server in unreachableServers" :key="`server-${server.id}`" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-warning-circle" class="mt-0.5 size-4 shrink-0 text-error" />
              <p class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] text-sm text-default sm:basis-0">
                Can't reach <span class="font-semibold">{{ server.name }}</span>{{ server.initializationError ? ':' : '' }}
                <span v-if="server.initializationError" class="font-mono text-xs break-words text-error">{{ server.initializationError }}</span>
              </p>
              <UButton :to="settingsLink('servers')" label="Edit" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- jack not set up in a Radarr/Sonarr, or that *arr can't reach jack -->
            <div v-for="problem in registrationProblems" :key="`registration-${problem.id}`" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-warning-circle" class="mt-0.5 size-4 shrink-0 text-error" />
              <p class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] text-sm break-words text-default sm:basis-0">
                <template v-if="problem.message">
                  {{ problem.message }}
                </template>
                <template v-else>
                  <span class="font-semibold">{{ problem.name }}</span>: jack couldn't add itself as {{ problem.step }}<span v-if="problem.error"> (<span class="font-mono text-xs break-words text-error">{{ problem.error }}</span>)</span>. Register again on its card.
                </template>
              </p>
              <!-- A failed test names the setting that fixes it; a failed step is fixed
                   with Register again on the server's card. -->
              <UButton v-if="problem.fix" :to="settingsLink(problem.fix.section)" :label="problem.fix.label" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
              <UButton v-else :to="settingsLink('servers')" label="Edit Radarr & Sonarr" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Radarr/Sonarr skip jack's indexer for now. It resumes by itself, so
                 there is no link. Register again on the server's card ends it once a
                 friend has new releases. -->
            <div v-for="pause in pausedIndexers" :key="`paused-${pause.id}`" class="flex gap-3 px-4 py-3">
              <UIcon name="i-ph-pause-circle" class="mt-0.5 size-4 shrink-0 text-warning" />
              <div class="min-w-0 flex-1">
                <p class="text-sm break-words text-default">
                  {{ pause.title }}
                </p>
                <p class="mt-1 text-xs text-muted">
                  {{ pause.detail }}
                </p>
              </div>
            </div>

            <!-- Downloads on, but nothing receives them -->
            <div v-if="onlySharesIsIssue" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-warning" class="mt-0.5 size-4 shrink-0 text-warning" />
              <p class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] text-sm text-default sm:basis-0">
                You only share. To get friends' movies and episodes into Radarr/Sonarr, turn on Download from friends for a Radarr or Sonarr.
              </p>
              <UButton :to="settingsLink('servers')" label="Edit Radarr & Sonarr" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Stuck imports -->
            <div v-if="queuedCount" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-clock-countdown" class="mt-0.5 size-4 shrink-0 text-warning" />
              <div class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                <p class="text-sm text-default">
                  {{ plural(queuedCount, 'download') }} waiting for Radarr/Sonarr to import
                </p>
                <p class="mt-1 text-xs text-muted">
                  {{ importHint }}
                </p>
                <p
                  v-for="d in stuckImports.slice(0, PREVIEW)"
                  :key="d.id"
                  class="mt-1 truncate text-xs text-muted"
                  :title="d.filename"
                >
                  <span class="text-toned">{{ d.filename }}</span>
                  · from {{ d.peerName }}
                  · waiting {{ formatAgo(d.completedAt ?? d.updatedAt) }}
                </p>
                <p v-if="queuedCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                  and {{ queuedCount - PREVIEW }} more
                </p>
              </div>
              <UButton to="/downloads?status=import_queued" label="View imports" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Failed downloads -->
            <div v-if="failedCount" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <UIcon name="i-ph-x-circle" class="mt-0.5 size-4 shrink-0 text-error" />
              <div class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                <p class="text-sm text-default">
                  {{ plural(failedCount, 'download') }} failed
                </p>
                <!-- The failure in plain words where jack knows it; the hover shows
                     the whole line and jack's own text. On a phone the reason gets
                     lines of its own, since a cut-off reason can't be hovered. -->
                <p
                  v-for="d in failed.slice(0, PREVIEW)"
                  :key="d.id"
                  class="mt-1 text-xs text-muted sm:truncate"
                  :title="failureTitle(d)"
                >
                  <span class="block truncate text-toned sm:inline">{{ d.filename }}</span>
                  <span class="hidden sm:inline"> · </span>
                  <span class="line-clamp-2 break-words sm:inline">{{ plainDownloadError(d) ?? d.error ?? 'unknown error' }}</span>
                </p>
                <p v-if="failedCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                  and {{ failedCount - PREVIEW }} more
                </p>
              </div>
              <UButton to="/downloads?status=failed" label="View failed downloads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="ml-7 shrink-0 px-0 sm:ml-0 sm:px-2.5" />
            </div>

            <!-- Size mismatches -->
            <div v-if="mismatchCount" class="flex gap-3 px-4 py-3">
              <UIcon name="i-ph-warning" class="mt-0.5 size-4 shrink-0 text-warning" />
              <div class="min-w-0">
                <p class="text-sm text-default">
                  {{ plural(mismatchCount, 'download') }} {{ mismatchCount === 1 ? 'reports' : 'report' }} a size mismatch
                </p>
                <p
                  v-for="d in mismatches.slice(0, PREVIEW)"
                  :key="d.id"
                  class="mt-1 truncate text-xs text-muted"
                  :title="d.filename"
                >
                  <span class="text-toned">{{ d.filename }}</span> · from {{ d.peerName }}
                </p>
                <p v-if="mismatchCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                  and {{ mismatchCount - PREVIEW }} more
                </p>
              </div>
            </div>
          </div>
        </template>
      </UCollapsible>
    </UCard>

    <!-- The overview is out of date (jack isn't answering): no claim either way. The
         layout's notice says what is going on. -->
    <UAlert
      v-else-if="stale"
      color="neutral"
      variant="subtle"
      icon="i-ph-clock-counter-clockwise"
      title="Can't tell whether anything is failing until jack answers again."
    />

    <!-- Nothing failing, but nothing set up either: no green, no false comfort. When
         the setup card shows a problem, it speaks for itself. -->
    <UAlert
      v-else-if="!setupShowsProblem && (nothingConfigured || setupState === 'open')"
      color="neutral"
      variant="subtle"
      icon="i-ph-info"
      :title="nothingConfigured ? 'Nothing is failing. Finish setup to start sharing.' : 'Nothing is failing. Setup isn\'t finished yet.'"
    />

    <!-- All clear: one calm, factual line. Not while a server is still being set up
         (`pending`) or jack waits for a restart (`restart`, the banner says so). -->
    <UAlert
      v-else-if="setupState === 'done'"
      color="success"
      variant="soft"
      icon="i-ph-check-circle"
      :title="allClearTitle"
    />

    <!-- Sharing only, with downloads off: worth knowing, not a problem. -->
    <UAlert
      v-if="onlyShares && !onlySharesIsIssue"
      color="info"
      variant="subtle"
      icon="i-ph-info"
      title="You only share."
      description="To get friends' movies and episodes into Radarr/Sonarr, turn on Download from friends for a Radarr or Sonarr."
      :actions="[{ label: 'Edit Radarr & Sonarr', to: settingsLink('servers'), color: 'info', variant: 'outline', size: 'sm' }]"
    />
  </div>
</template>
