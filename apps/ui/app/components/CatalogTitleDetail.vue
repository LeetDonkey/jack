<script setup lang="ts">
import type { CatalogTitle, CatalogTitlePeer } from '~/types/management'
import type { RequestGate } from '~/utils/catalog'

const props = withDefaults(defineProps<{
  title: CatalogTitle
  // Why Download can't send this title anywhere right now; null when it can.
  gate?: RequestGate | null
  // A warning per friend id whose library here may be out of date (offline, or not refreshed).
  peerWarnings?: Record<string, string>
}>(), { gate: null, peerWarnings: () => ({}) })
const emit = defineEmits<{ download: [peerId: string] }>()

const { load, entryFor } = useCatalogMetadata()
// Reuse the cache the grid populated; load() is a no-op if the card already fetched it.
const meta = computed(() => mergeCatalogMetadata(props.title.metadata, entryFor(props.title)?.data))
const name = computed(() => meta.value?.title ?? props.title.displayTitle)
// Prefer the wide backdrop, fall back to the poster — covers titles with only one
// image and transient TMDB load failures (the poster is usually already cached by
// the card). Null once both fail, so the box is hidden rather than left blank.
const { src: heroImage, onError: onHeroError } = useFallbackImage(() => [
  meta.value?.backdropUrl,
  meta.value?.posterUrl,
])

onMounted(() => {
  if (needsTmdbMetadata(props.title))
    load(props.title)
})

const pluralReleases = (n: number) => `${n} release${n === 1 ? '' : 's'}`
// A single-peer title gets a friendlier phrasing; otherwise we render a card per peer
// so the user can pick which one to download from.
const singlePeer = computed(() => props.title.peers.length === 1 ? props.title.peers[0]! : null)
const { dotClass } = usePeerColors()

function formatResolution(res?: number): string | null {
  if (res == null)
    return null
  if (res >= 2160)
    return '4K'
  if (res >= 1080)
    return '1080p'
  if (res >= 720)
    return '720p'
  if (res >= 480)
    return '480p'
  return `${res}p`
}
// Distinct resolution labels a peer carries, best first — the decision-relevant "what
// quality can I get here" without listing every individual file.
function peerResolutions(peer: CatalogTitlePeer): string[] {
  const nums = peer.releases
    .map(r => r.quality?.resolution)
    .filter((n): n is number => n != null)
  const labels = [...new Set(nums)].sort((a, b) => b - a).map(formatResolution)
  return [...new Set(labels.filter((l): l is string => l != null))]
}
const hasId = computed(() => props.title.mediaType === 'tv'
  ? props.title.tvdbId != null
  : props.title.tmdbId != null)

// Why Download can't work right now, said before the click, with the way to fix it.
const gateCopy = computed<{ title: string, description?: string, action?: { label: string, to: string } } | null>(() => {
  const gate = props.gate
  if (!gate)
    return null
  switch (gate.kind) {
    case 'off':
      return {
        title: 'Downloads are off, so jack can\'t download this.',
        action: { label: 'Turn on downloads', to: settingsLink('downloads') },
      }
    case 'restart':
      return {
        title: 'Restart the jack container first.',
        description: `Downloads were turned on after jack started. Unraid: ${RESTART_STEPS}.`,
      }
    case 'no-destination':
      return {
        title: `To download ${props.title.mediaType === 'tv' ? 'TV shows' : 'movies'}, turn on Download from friends for a ${gate.arr}.`,
        action: { label: 'Open Radarr & Sonarr', to: settingsLink('servers') },
      }
    case 'unreachable':
      return {
        title: `jack can't reach ${new Intl.ListFormat('en', { type: 'disjunction' }).format(gate.names)} right now, so there's nowhere to send this.`,
        action: { label: 'Open Radarr & Sonarr', to: settingsLink('servers') },
      }
    default:
      return null
  }
})

const canRequest = computed(() => hasId.value && !props.gate)
// Hover hint on the Download button: explain the disabled state, or for requestable
// TV titles clarify that the whole series is grabbed.
const downloadHint = computed(() => {
  if (!hasId.value)
    return 'This title has no matching id to request'
  if (gateCopy.value)
    return gateCopy.value.title
  if (props.title.mediaType === 'tv')
    return 'Downloads every available episode of this series.'
  return null
})
// Logflix keys both movies and TV off the TMDB id (e.g. /movie/1301421, /tv/246461).
// Only link out once TMDB metadata actually resolved — a bare id with no data means
// the title isn't on TMDB, so the Logflix page wouldn't resolve either.
const logflixUrl = computed(() => props.title.tmdbId == null || meta.value == null
  ? null
  : `https://logflix.eu/${props.title.mediaType}/${props.title.tmdbId}`)
</script>

<template>
  <div class="space-y-4">
    <div v-if="heroImage" class="aspect-video overflow-hidden rounded-lg bg-muted">
      <img :src="heroImage" :alt="name" class="size-full object-cover" @error="onHeroError">
    </div>

    <!-- The panel's header has the name. -->
    <div class="flex flex-wrap items-center gap-2">
      <span v-if="meta?.year" class="text-sm text-muted">{{ meta.year }}</span>
      <UBadge :label="title.mediaType === 'tv' ? 'TV' : 'Movie'" color="neutral" variant="subtle" />
      <UBadge v-if="meta?.rating" :label="meta.rating.toFixed(1)" icon="i-ph-star-fill" color="warning" variant="subtle" />
      <UBadge v-for="g in meta?.genres ?? []" :key="g" :label="g" color="neutral" variant="soft" size="sm" />
    </div>

    <p v-if="meta?.overview" class="text-sm leading-relaxed text-toned">
      {{ meta.overview }}
    </p>
    <p v-else class="text-sm text-muted">
      No description available.
    </p>

    <USeparator />

    <!-- Download can't work right now: why, and where to fix it. -->
    <UAlert
      v-if="gateCopy"
      color="warning"
      variant="subtle"
      icon="i-ph-warning"
      :title="gateCopy.title"
      :description="gateCopy.description"
      :actions="gateCopy.action ? [{ label: gateCopy.action.label, to: gateCopy.action.to, color: 'warning', variant: 'outline', size: 'sm' }] : undefined"
    />

    <!-- Single peer: friendly summary line + one Download button. -->
    <template v-if="singlePeer">
      <p class="text-xs text-muted">
        {{ pluralReleases(title.releaseCount) }} available from {{ singlePeer.name }}'s library · {{ formatBytes(title.totalSize) }}
      </p>
      <p v-if="peerWarnings[singlePeer.id]" class="flex items-start gap-1.5 text-xs text-warning">
        <UIcon name="i-ph-warning" class="mt-px size-3.5 shrink-0" />
        {{ peerWarnings[singlePeer.id] }}
      </p>
      <UTooltip :disabled="!downloadHint" :text="downloadHint ?? ''" :delay-duration="0">
        <!-- Wrap in a span so the tooltip still fires while the button is disabled:
             a native disabled button swallows hover events, so pointer-events-none on it
             lets them fall through to this trigger. -->
        <span class="block">
          <UButton
            label="Download"
            icon="i-ph-download-simple"
            :disabled="!canRequest"
            :class="canRequest ? undefined : 'pointer-events-none'"
            block
            @click="emit('download', singlePeer.id)"
          />
        </span>
      </UTooltip>
    </template>

    <!-- Multiple peers: a card per peer so the user can pick where to download from.
         The download grabs the whole title (best release per movie / per episode) from
         the chosen peer, so the choice is the peer, not an individual file. -->
    <template v-else>
      <p class="text-xs text-muted">
        {{ pluralReleases(title.releaseCount) }} across {{ title.peers.length }} friends · {{ formatBytes(title.totalSize) }}
      </p>
      <div class="space-y-2">
        <div
          v-for="peer in title.peers"
          :key="peer.id"
          class="flex items-start justify-between gap-3 rounded-lg p-3 ring-1 ring-default"
        >
          <div class="min-w-0 space-y-1.5">
            <p class="flex items-center gap-1.5 text-sm font-medium text-default">
              <span class="size-2 shrink-0 rounded-full" :class="dotClass(peer.id)" />
              <span class="truncate">{{ peer.name }}</span>
            </p>
            <p class="text-xs text-muted">
              {{ pluralReleases(peer.releaseCount) }} · {{ formatBytes(peer.totalSize) }}
            </p>
            <div v-if="peerResolutions(peer).length" class="flex flex-wrap gap-1">
              <UBadge v-for="r in peerResolutions(peer)" :key="r" :label="r" size="sm" color="neutral" variant="soft" />
            </div>
            <p v-if="peerWarnings[peer.id]" class="flex items-start gap-1.5 text-xs text-warning">
              <UIcon name="i-ph-warning" class="mt-px size-3.5 shrink-0" />
              {{ peerWarnings[peer.id] }}
            </p>
          </div>
          <UTooltip :disabled="!downloadHint" :text="downloadHint ?? ''" :delay-duration="0">
            <span class="block shrink-0">
              <UButton
                label="Download"
                icon="i-ph-download-simple"
                size="sm"
                :disabled="!canRequest"
                :class="canRequest ? undefined : 'pointer-events-none'"
                @click="emit('download', peer.id)"
              />
            </span>
          </UTooltip>
        </div>
      </div>
    </template>

    <!-- Another site's page about the title, after Download: not needed to get it.
         Hidden when TMDB doesn't know the title, as Logflix wouldn't either. -->
    <UButton
      v-if="logflixUrl"
      :to="logflixUrl"
      target="_blank"
      label="More info (Logflix)"
      trailing-icon="i-ph-arrow-square-out"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
    >
      <template #leading>
        <img src="/logflix.svg" alt="" class="size-4">
      </template>
    </UButton>
  </div>
</template>
