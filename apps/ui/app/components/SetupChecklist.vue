<script setup lang="ts">
import type { SetupStatus } from '~/composables/useSetupStatus'
import type { SetupStepState } from '~/utils/setup-steps'

// The dashboard's first-run guide: the required steps in order, then an optional
// card for sharing with friends. All state comes from useSetupStatus (the page owns
// it, because the attention panel needs the same answer). `now` is the page's
// ticking clock, so "Checked 5 min ago" moves on while the page stays open.
// `stale`: jack isn't answering, so the steps are what jack last said, marked like
// the dashboard's other sections.
const props = defineProps<{ status: SetupStatus, now: number, stale?: boolean }>()

const MARKERS: Record<Exclude<SetupStepState, 'open'>, { icon: string, class: string, label: string }> = {
  done: { icon: 'i-ph-check-circle-fill', class: 'text-success', label: 'Done' },
  skipped: { icon: 'i-ph-minus-circle', class: 'text-dimmed', label: 'Skipped' },
  check: { icon: 'i-ph-warning-circle-fill', class: 'text-warning', label: 'Check this' },
  pending: { icon: 'i-ph-circle-notch', class: 'animate-spin text-muted', label: 'Checking' },
  untested: { icon: 'i-ph-circle-dashed', class: 'text-muted', label: 'Not tested yet' },
}

const isDone = isSetupStepDone

// With a server connected but none in the needed role, "Connect" would read as done.
const SERVER_STEP_TITLES = {
  'no-destination': 'Let Radarr or Sonarr receive downloads',
  'no-source': 'Let Radarr or Sonarr share with friends',
} as const

type RequiredStepId = 'internal-url' | 'downloads' | 'servers' | 'restart'

const requiredSteps = computed(() => {
  const { reason, state } = props.status.serversStep
  const steps: Array<{ id: RequiredStepId, title: string, state: SetupStepState }> = [
    { id: 'internal-url', title: 'Tell jack how Radarr/Sonarr reach it', state: props.status.internalUrlStep.state },
    { id: 'downloads', title: 'Turn on downloads', state: props.status.downloadsStep },
    {
      id: 'servers',
      title: reason === 'no-destination' || reason === 'no-source' ? SERVER_STEP_TITLES[reason] : 'Connect Radarr or Sonarr',
      state,
    },
  ]
  // Last, so one restart picks up everything the steps above changed.
  if (props.status.restartStep)
    steps.push({ id: 'restart', title: 'Restart the jack container', state: props.status.restartStep })
  return steps
})

const sharingSteps = computed(() => [
  { id: 'address', title: 'Set the address friends use', state: props.status.addressStep },
  { id: 'friend', title: 'Invite or add a friend', state: props.status.friendStep },
] as const)

const restartLabels = computed(() => restartReasonLabels(props.status.restartReasons).join(', '))

// The folder check, once useSetupStatus says there are folders to check. It never
// runs by itself here; saves in Settings and the Check folders button run it. A
// problem it found is kept across reloads.
const { lastReport: folderReport, running: folderRunning, error: folderError, run: runFolderCheck } = useFolderCheck()
// A kept report can be old, so a problem says when it was found.
const folderCheckedAgo = computed(() => folderReport.value ? formatTimeAgo(folderReport.value.checkedAt, props.now) : '')
const FOLDER_TONE = {
  ok: { icon: 'i-ph-check-circle', class: 'text-success' },
  warning: { icon: 'i-ph-warning-circle', class: 'text-warning' },
  error: { icon: 'i-ph-x-circle', class: 'text-error' },
} as const
// Downloads has the full report; with downloads off, the Radarr/Sonarr cards show it.
const folderFix = computed(() => props.status.downloadsStep === 'done'
  ? { to: settingsLink('downloads'), label: 'See the folder check' }
  : { to: settingsLink('servers'), label: 'Edit Radarr & Sonarr' })

// Server names inside a sentence: "Radarr and Sonarr".
const nameList = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
const listNames = (names: readonly string[]) => nameList.format(names)

// The setup card's title: done, done but for a failed folder check, or the count.
const setupTitle = computed(() => {
  if (props.status.setupComplete)
    return 'jack is set up'
  if (props.status.requiredComplete)
    return 'Finish setting up jack'
  return `Finish setting up jack (${props.status.requiredDone} of ${props.status.requiredTotal})`
})

// jack-ui usually runs on the same server as jack, so when this page was opened by
// IPv4 address, that address is the likely answer. Otherwise show a placeholder.
const requestHost = useRequestURL().hostname
const suggestedUrl = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(requestHost) && !requestHost.startsWith('127.')
  ? `http://${requestHost}:5225`
  : 'http://<server-ip>:5225'
</script>

<template>
  <div v-if="status.showSetupCard || status.showSharingCard" class="space-y-4">
    <!-- Required steps. -->
    <UCard v-if="status.showSetupCard" variant="subtle" class="transition-[filter]" :class="{ grayscale: stale }" :ui="{ body: '!p-0' }">
      <div class="flex items-center gap-3 px-4 py-3.5">
        <UIcon
          :name="status.setupComplete ? 'i-ph-check-circle' : 'i-ph-list-checks'"
          class="size-5 shrink-0"
          :class="status.setupComplete ? 'text-success' : 'text-primary'"
        />
        <h2 class="text-sm font-semibold text-highlighted">
          {{ setupTitle }}<span v-if="stale" class="font-normal text-muted"> · last known</span>
        </h2>
        <UButton
          v-if="status.setupComplete"
          label="Hide"
          color="neutral"
          variant="ghost"
          size="xs"
          class="ml-auto"
          @click="status.hideSetup()"
        />
      </div>

      <!-- Everything done: someone who only shares still gets the way back to downloading. -->
      <div v-if="status.requiredComplete && status.shareOnly" class="border-t border-default px-4 py-3.5">
        <p class="text-sm text-muted">
          <template v-if="status.downloadsOn">
            You only share. To get friends' movies and episodes into Radarr/Sonarr, turn on Download from friends for a Radarr or Sonarr.
          </template>
          <template v-else>
            You only share. Turn on downloads when you want friends' movies and episodes in Radarr/Sonarr.
          </template>
        </p>
        <div class="pt-2">
          <UButton v-if="status.downloadsOn" :to="settingsLink('servers')" label="Edit Radarr & Sonarr" size="sm" color="neutral" variant="outline" />
          <UButton v-else :to="settingsLink('downloads')" label="Turn on downloads" size="sm" color="neutral" variant="outline" />
        </div>
      </div>

      <ol v-else-if="!status.requiredComplete" class="divide-y divide-default border-t border-default">
        <li v-for="(step, index) in requiredSteps" :key="step.id" class="flex gap-3 px-4 py-3.5">
          <span class="flex size-5 shrink-0 items-center justify-center">
            <span
              v-if="step.state === 'open'"
              class="flex size-5 items-center justify-center rounded-full text-xs font-semibold text-muted ring-1 ring-inset ring-accented"
              aria-hidden="true"
            >{{ index + 1 }}</span>
            <UIcon v-else :name="MARKERS[step.state].icon" class="size-5" :class="MARKERS[step.state].class" />
            <span class="sr-only">{{ step.state === 'open' ? 'To do' : MARKERS[step.state].label }}:</span>
          </span>

          <div class="min-w-0 flex-1 space-y-1.5">
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium" :class="isDone(step.state) ? 'text-toned' : 'text-highlighted'">
              {{ step.title }}
              <UBadge v-if="step.state === 'check'" color="warning" variant="subtle" size="sm" label="Check this" />
            </p>

            <!-- 1. Internal URL. Done only when a Radarr/Sonarr test of jack passed, or,
                 where jack can't test it, when the user confirmed the address. -->
            <template v-if="step.id === 'internal-url'">
              <template v-if="status.internalUrlStep.reason === 'failed'">
                <p v-for="failure in status.internalUrlStep.failures" :key="failure.id" class="text-sm break-words text-default">
                  {{ failure.message }}
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <UButton :to="settingsLink('internal-url')" label="Change the address" size="sm" variant="soft" />
                  <UButton :to="settingsLink('servers')" label="Edit Radarr & Sonarr" size="sm" color="neutral" variant="outline" />
                </div>
              </template>
              <template v-else-if="status.internalUrlStep.reason === 'default'">
                <p class="text-sm text-muted">
                  Is Radarr/Sonarr on the jack Docker network? If not, use
                  <span class="inline-block max-w-full font-mono text-xs break-all text-toned">{{ suggestedUrl }}</span>.
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <UButton :to="settingsLink('internal-url')" label="Change the address" size="sm" variant="soft" />
                  <UButton label="Yes, on the jack network" size="sm" color="neutral" variant="outline" @click="status.confirmInternalUrl()" />
                </div>
              </template>
              <!-- Auto-register is off for every server that receives downloads. -->
              <template v-else-if="status.internalUrlStep.reason === 'untestable'">
                <p class="text-sm text-muted">
                  jack doesn't add itself to {{ listNames(status.internalUrlStep.manual) }}, so it can't test this address.
                  {{ listNames(status.internalUrlStep.manual) }} must reach jack at
                  <span class="inline-block max-w-full font-mono text-xs break-all text-toned">{{ status.internalUrl }}</span>.
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <UButton :to="settingsLink('internal-url')" label="Change the address" size="sm" variant="soft" />
                  <UButton label="Yes, this address works" size="sm" color="neutral" variant="outline" @click="status.confirmInternalUrl()" />
                </div>
              </template>
              <p v-else-if="status.internalUrlStep.reason === 'reached'" class="text-sm text-muted">
                {{ listNames(status.internalUrlStep.reachedBy) }} reached jack at
                <span class="inline-block max-w-full font-mono text-xs break-all text-toned">{{ status.internalUrl }}</span>.
              </p>
              <p v-else-if="status.internalUrlStep.reason === 'confirmed'" class="text-sm text-muted">
                You confirmed that Radarr/Sonarr reach jack at
                <span class="inline-block max-w-full font-mono text-xs break-all text-toned">{{ status.internalUrl }}</span>.
              </p>
              <p v-else-if="status.internalUrlStep.reason === 'share-only'" class="text-sm text-muted">
                Skipped, because you only share.
                <UButton label="Undo" size="sm" variant="link" class="p-0 align-baseline" @click="status.setShareOnly(false)" />
              </p>
              <!-- Not tested yet: the test runs once jack has added itself to a
                   Radarr/Sonarr. When jack tried and failed, step 3 says why. -->
              <p v-else class="text-sm text-muted">
                jack gives Radarr/Sonarr the address
                <span class="inline-block max-w-full font-mono text-xs break-all text-toned">{{ status.internalUrl }}</span>.
                <template v-if="status.serversStep.reason === 'not-added'">
                  Nothing has tested it, because jack isn't in {{ listNames(status.serversStep.names) }} yet (step 3).
                </template>
                <template v-else>
                  It's tested when jack adds itself to a Radarr or Sonarr.
                </template>
              </p>
            </template>

            <!-- 2. Downloads -->
            <template v-else-if="step.id === 'downloads'">
              <template v-if="step.state === 'open'">
                <p class="text-sm text-muted">
                  Friends' movies and episodes can't reach your Radarr/Sonarr until downloads are on.
                </p>
                <div class="flex flex-wrap items-center gap-2 pt-1">
                  <UButton :to="settingsLink('downloads')" label="Turn on downloads" size="sm" variant="soft" />
                  <UButton v-if="status.shareOnlyOffer === 'downloads'" label="I only share" size="sm" color="neutral" variant="link" @click="status.setShareOnly(true)" />
                </div>
              </template>
              <!-- Undo sits on step 1, which is skipped too. -->
              <p v-else-if="step.state === 'skipped'" class="text-sm text-muted">
                Skipped, because you only share.
              </p>
              <p v-else-if="status.completedPath" class="text-sm text-muted">
                Finished downloads go to <span class="inline-block max-w-full font-mono text-xs break-all text-toned">{{ status.completedPath }}</span>.
              </p>
            </template>

            <!-- 3. Radarr / Sonarr. Receiving needs jack's download client and indexer in one of them. -->
            <template v-else-if="step.id === 'servers'">
              <p v-if="step.state === 'done'" class="text-sm text-muted">
                Connected: {{ status.serversStep.names.join(', ') }}.
              </p>
              <p v-else-if="status.serversStep.reason === 'registering'" class="text-sm text-muted">
                Adding jack to {{ listNames(status.serversStep.names) }}…
              </p>
              <p v-else-if="step.state === 'pending'" class="text-sm text-muted">
                Connecting to {{ listNames(status.serversStep.names) }}…
              </p>
              <template v-else-if="status.serversStep.reason === 'none'">
                <p class="text-sm text-muted">
                  Add the Radarr or Sonarr that should share with friends or receive downloads.
                </p>
                <div class="pt-1">
                  <UButton :to="settingsLink('servers')" label="Connect Radarr or Sonarr" size="sm" variant="soft" />
                </div>
              </template>
              <p v-else-if="status.serversStep.reason === 'downloads-off'" class="text-sm text-muted">
                jack adds itself to {{ listNames(status.serversStep.names) }} once downloads are on.
              </p>
              <template v-else-if="status.serversStep.reason === 'not-added'">
                <p v-for="problem in status.serversStep.problems" :key="problem.id" class="text-sm break-words text-default">
                  {{ problem.message }}
                </p>
                <div class="pt-1">
                  <UButton :to="settingsLink('servers')" label="Edit Radarr & Sonarr" size="sm" variant="soft" />
                </div>
              </template>
              <template v-else>
                <p v-if="status.serversStep.reason === 'no-destination'" class="text-sm text-muted">
                  None of them has Download from friends turned on, so friends' downloads have nowhere to go.
                </p>
                <p v-else-if="status.serversStep.reason === 'no-source'" class="text-sm text-muted">
                  None of them shares its library with friends, so friends find nothing to download from you.
                </p>
                <p v-else class="text-sm text-muted">
                  jack can't reach {{ listNames(status.serversStep.names) }}. Check the address and API key.
                </p>
                <div class="flex flex-wrap items-center gap-2 pt-1">
                  <UButton :to="settingsLink('servers')" label="Edit Radarr & Sonarr" size="sm" variant="soft" />
                  <!-- Sharing only is a valid setup: it then needs a server that shares
                       instead. Offered here only while step 2 doesn't offer it. -->
                  <UButton
                    v-if="status.shareOnlyOffer === 'servers'"
                    label="I only share"
                    size="sm"
                    color="neutral"
                    variant="link"
                    @click="status.setShareOnly(true)"
                  />
                </div>
              </template>
            </template>

            <!-- 4. Restart, only while turning on downloads or a new completed folder waits for it. -->
            <p v-else class="text-sm text-muted">
              <template v-if="status.restartReasons.includes('downloads')">
                Radarr/Sonarr can't use jack's download client until jack restarts.
              </template>
              <template v-else>
                These settings apply after the restart: {{ restartLabels }}.
              </template>
              Unraid: <span class="whitespace-nowrap">{{ RESTART_STEPS }}</span>.
            </p>
          </div>
        </li>
      </ol>

      <!-- Folders: the most common Unraid mistake is a path Radarr/Sonarr see differently. -->
      <div v-if="status.folderCheckReady" class="space-y-1.5 border-t border-default px-4 py-3.5">
        <template v-if="status.folderResult">
          <p class="flex items-start gap-2 text-sm" :class="FOLDER_TONE[status.folderResult.tone].class">
            <UIcon :name="FOLDER_TONE[status.folderResult.tone].icon" class="mt-0.5 size-4 shrink-0" />
            <span class="min-w-0 break-words">{{ status.folderResult.text }}</span>
          </p>
          <div v-if="status.folderResult.tone !== 'ok'" class="flex flex-wrap items-center gap-2 pt-1 pl-6">
            <UButton :to="folderFix.to" :label="folderFix.label" size="sm" variant="soft" />
            <UButton label="Check again" size="sm" color="neutral" variant="link" :loading="folderRunning" @click="runFolderCheck" />
            <span v-if="folderCheckedAgo && !folderRunning" class="text-xs text-dimmed">Checked {{ folderCheckedAgo }}.</span>
          </div>
          <p v-if="folderError" class="pl-6 text-sm break-words text-error">
            {{ folderError }}
          </p>
        </template>
        <template v-else>
          <p class="text-sm text-muted">
            Check that jack and Radarr/Sonarr see the same folders at the same paths.
          </p>
          <p v-if="folderError" class="text-sm break-words text-error">
            {{ folderError }}
          </p>
          <p v-else-if="folderRunning" class="text-xs text-muted">
            Checking… this can take up to 30 seconds.
          </p>
          <div class="pt-1">
            <UButton label="Check folders" icon="i-ph-folders" size="sm" color="neutral" variant="outline" :loading="folderRunning" @click="runFolderCheck" />
          </div>
        </template>
      </div>
    </UCard>

    <!-- Optional: sharing with friends. Never counts towards the steps above. -->
    <UCard v-if="status.showSharingCard" variant="subtle" class="transition-[filter]" :class="{ grayscale: stale }" :ui="{ body: '!p-0' }">
      <div class="flex items-center gap-3 px-4 py-3.5">
        <UIcon name="i-ph-users-three" class="size-5 shrink-0 text-muted" />
        <h2 class="text-sm font-semibold text-highlighted">
          Share with friends
        </h2>
        <UBadge color="neutral" variant="subtle" size="sm" label="Optional" />
        <UButton label="Hide" color="neutral" variant="ghost" size="xs" class="ml-auto" @click="status.hideSharing()" />
      </div>

      <ul class="divide-y divide-default border-t border-default">
        <li v-for="step in sharingSteps" :key="step.id" class="flex gap-3 px-4 py-3.5">
          <span class="flex size-5 shrink-0 items-center justify-center">
            <UIcon v-if="isDone(step.state)" name="i-ph-check-circle-fill" class="size-5 text-success" />
            <span v-else class="size-3.5 rounded-full ring-1 ring-inset ring-accented" aria-hidden="true" />
            <span class="sr-only">{{ isDone(step.state) ? 'Done' : 'To do' }}:</span>
          </span>

          <div class="min-w-0 flex-1 space-y-1.5">
            <p class="text-sm font-medium" :class="isDone(step.state) ? 'text-toned' : 'text-highlighted'">
              {{ step.title }}
            </p>
            <template v-if="!isDone(step.state)">
              <template v-if="step.id === 'address'">
                <p class="text-sm text-muted">
                  Set your name and the address friends use, so your invite links carry them.
                </p>
                <div class="pt-1">
                  <UButton :to="settingsLink('public-address')" label="Set the address" size="sm" color="neutral" variant="outline" />
                </div>
              </template>
              <template v-else>
                <p class="text-sm text-muted">
                  Send a friend an invite link, or paste the link a friend sent you.
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <UButton to="/friends?action=invite" label="Invite a friend" icon="i-ph-link" size="sm" color="neutral" variant="outline" />
                  <UButton to="/friends?action=add" label="Add a friend" icon="i-ph-user-plus" size="sm" color="neutral" variant="outline" />
                </div>
              </template>
            </template>
          </div>
        </li>
      </ul>
    </UCard>
  </div>
</template>
