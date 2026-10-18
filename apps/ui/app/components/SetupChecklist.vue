<script setup lang="ts">
import type { SetupStatus, SetupStepState } from '~/composables/useSetupStatus'

// The dashboard's first-run guide: the required steps in order, then an optional
// card for sharing with friends. All state comes from useSetupStatus (the page owns
// it, because the attention panel needs the same answer).
const props = defineProps<{ status: SetupStatus }>()

const MARKERS: Record<Exclude<SetupStepState, 'open'>, { icon: string, class: string, label: string }> = {
  done: { icon: 'i-ph-check-circle-fill', class: 'text-success', label: 'Done' },
  skipped: { icon: 'i-ph-minus-circle', class: 'text-dimmed', label: 'Skipped' },
  check: { icon: 'i-ph-warning-circle-fill', class: 'text-warning', label: 'Check this' },
  pending: { icon: 'i-ph-circle-notch', class: 'animate-spin text-muted', label: 'Checking' },
}

const isDone = (state: SetupStepState) => state === 'done' || state === 'skipped'

// With a server connected but none in the needed role, "Connect" would read as done.
const SERVER_STEP_TITLES = {
  'no-destination': 'Let Radarr or Sonarr receive downloads',
  'no-source': 'Let Radarr or Sonarr share with friends',
} as const

const requiredSteps = computed(() => {
  const { reason, state } = props.status.serversStep
  return [
    { id: 'internal-url', title: 'Tell jack how Radarr/Sonarr reach it', state: props.status.internalUrlStep },
    { id: 'downloads', title: 'Turn on downloads', state: props.status.downloadsStep },
    {
      id: 'servers',
      title: reason === 'no-destination' || reason === 'no-source' ? SERVER_STEP_TITLES[reason] : 'Connect Radarr or Sonarr',
      state,
    },
  ] as const
})

const sharingSteps = computed(() => [
  { id: 'address', title: 'Set the address friends use', state: props.status.addressStep },
  { id: 'friend', title: 'Invite or add a friend', state: props.status.friendStep },
] as const)

// jack-ui usually runs on the same server as jack, so when this page was opened by
// IPv4 address, that address is the likely answer. Otherwise show a placeholder.
const requestHost = useRequestURL().hostname
const suggestedUrl = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(requestHost) && !requestHost.startsWith('127.')
  ? `http://${requestHost}:5225`
  : 'http://<server-ip>:5225'

// Kept on one line, so "->" never breaks between its two characters.
const RESTART_HOW = '(Unraid: Docker tab -> jack -> Restart)'
</script>

<template>
  <div v-if="status.showSetupCard || status.showSharingCard" class="space-y-4">
    <!-- Required steps. -->
    <UCard v-if="status.showSetupCard" variant="subtle" :ui="{ body: '!p-0' }">
      <div class="flex items-center gap-3 px-4 py-3.5">
        <UIcon
          :name="status.requiredComplete ? 'i-ph-check-circle' : 'i-ph-list-checks'"
          class="size-5 shrink-0"
          :class="status.requiredComplete ? 'text-success' : 'text-primary'"
        />
        <h2 class="text-sm font-semibold text-highlighted">
          <template v-if="status.requiredComplete">
            jack is set up
          </template>
          <template v-else>
            Finish setting up jack ({{ status.requiredDone }} of {{ status.requiredTotal }})
          </template>
        </h2>
        <UButton
          v-if="status.requiredComplete"
          label="Hide"
          color="neutral"
          variant="ghost"
          size="xs"
          class="ml-auto"
          @click="status.hideSetup()"
        />
      </div>

      <!-- Everything done: keep the one reminder people miss until it is hidden. -->
      <div v-if="status.requiredComplete" class="border-t border-default px-4 py-3.5">
        <template v-if="status.shareOnly">
          <p class="text-sm text-muted">
            You only share. Turn on downloads when you want friends' movies and episodes in Radarr/Sonarr.
          </p>
          <div class="pt-2">
            <UButton :to="settingsLink('downloads')" label="Turn on downloads" size="sm" color="neutral" variant="outline" />
          </div>
        </template>
        <p v-else class="text-sm text-muted">
          If you turned on downloads after jack started, restart the jack container once
          <span class="whitespace-nowrap">{{ RESTART_HOW }}</span>.
        </p>
      </div>

      <ol v-else class="divide-y divide-default border-t border-default">
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

            <!-- 1. Internal URL -->
            <template v-if="step.id === 'internal-url'">
              <template v-if="step.state === 'check'">
                <p class="text-sm text-muted">
                  Is Radarr/Sonarr on the jack Docker network? If not, use
                  <span class="font-mono text-xs text-toned">{{ suggestedUrl }}</span>.
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <UButton :to="settingsLink('internal-url')" label="Change the address" size="sm" variant="soft" />
                  <UButton label="Yes, on the jack network" size="sm" color="neutral" variant="outline" @click="status.ackInternalUrl()" />
                </div>
              </template>
              <p v-else class="text-sm text-muted">
                Radarr/Sonarr reach jack at <span class="font-mono text-xs text-toned">{{ status.internalUrl }}</span>.
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
                  <UButton label="I only share" size="sm" color="neutral" variant="link" @click="status.setShareOnly(true)" />
                </div>
              </template>
              <p v-else-if="step.state === 'skipped'" class="text-sm text-muted">
                Skipped, because you only share.
                <UButton label="Undo" size="sm" variant="link" class="p-0 align-baseline" @click="status.setShareOnly(false)" />
              </p>
              <p v-else class="text-sm text-muted">
                If you turned this on after jack started, restart the jack container once
                <span class="whitespace-nowrap">{{ RESTART_HOW }}</span>.
              </p>
            </template>

            <!-- 3. Radarr / Sonarr -->
            <template v-else>
              <p v-if="step.state === 'done'" class="text-sm text-muted">
                Connected: {{ status.serversStep.names.join(', ') }}.
              </p>
              <p v-else-if="step.state === 'pending'" class="text-sm text-muted">
                Connecting to {{ status.serversStep.names.join(', ') }}…
              </p>
              <template v-else-if="status.serversStep.reason === 'none'">
                <p class="text-sm text-muted">
                  Add the Radarr or Sonarr that should share with friends or receive downloads.
                </p>
                <div class="pt-1">
                  <UButton :to="settingsLink('servers')" label="Connect Radarr or Sonarr" size="sm" variant="soft" />
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
                  jack can't reach {{ status.serversStep.names.join(', ') }}. Check the address and API key.
                </p>
                <div class="pt-1">
                  <UButton :to="settingsLink('servers')" label="Edit Radarr & Sonarr" size="sm" variant="soft" />
                </div>
              </template>
            </template>
          </div>
        </li>
      </ol>
    </UCard>

    <!-- Optional: sharing with friends. Never counts towards the steps above. -->
    <UCard v-if="status.showSharingCard" variant="subtle" :ui="{ body: '!p-0' }">
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
                  Fill in Instance name and External URL, so the links you send carry your name and address.
                </p>
                <div class="pt-1">
                  <UButton :to="settingsLink('public-address')" label="Set the address" size="sm" color="neutral" variant="outline" />
                </div>
              </template>
              <template v-else>
                <p class="text-sm text-muted">
                  Send a friend a link, or paste the link a friend sent you.
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <UButton :to="settingsLink('public-address')" label="Generate quick link" icon="i-ph-link" size="sm" color="neutral" variant="outline" />
                  <UButton :to="settingsLink('peers')" label="Add a friend" icon="i-ph-plus" size="sm" color="neutral" variant="outline" />
                </div>
              </template>
            </template>
          </div>
        </li>
      </ul>
    </UCard>
  </div>
</template>
