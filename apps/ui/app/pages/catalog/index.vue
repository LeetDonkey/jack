<script setup lang="ts">
import type { CatalogRequestPayload, CatalogResponse, CatalogTitle } from '~/types/management'

const { request, extractError } = useManagement()
const { entryFor } = useCatalogMetadata()
const toast = useToast()

// Lazy (no top-level await) so navigation into the page is instant; the grid shows
// skeletons until the first catalog arrives.
const { data, error, refresh } = useLazyAsyncData(
  'peer-catalog',
  () => request<CatalogResponse>('catalog'),
)

// Peer catalogs are cached on the server for 15 minutes; the refresh button asks the
// peers again. It fetches outside the async data, because a failed asyncData refresh
// empties `data`: this way a failed refresh keeps the grid and only toasts.
const refreshing = ref(false)
async function refreshCatalog() {
  refreshing.value = true
  try {
    data.value = await request<CatalogResponse>('catalog?refresh=true')
    error.value = undefined
  }
  catch (err) {
    toast.add({ color: 'error', title: extractError(err, 'Could not refresh your friends\' library.') })
  }
  finally {
    refreshing.value = false
  }
}

// "Updated 5m ago" has to move on its own; formatAgo reads the clock, which Vue doesn't track.
const clock = ref(Date.now())
const clockTimer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
  clockTimer.value = setInterval(() => {
    clock.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => clearInterval(clockTimer.value))
const updatedAgo = computed(() => {
  void clock.value
  return data.value?.updatedAt ? formatAgo(data.value.updatedAt) : null
})

// Distinct, view-consistent peer colors from the shared settings store. Provided so
// the poster badges and detail cards resolve the same color for a given peer.
const { settings } = useSettings()
providePeerColors(computed(() => settings.value?.peerColors ?? new Map()))

const typeFilter = ref<'all' | 'movie' | 'tv'>('all')
const titles = computed(() => {
  const all = data.value?.titles ?? []
  return typeFilter.value === 'all' ? all : all.filter(t => t.mediaType === typeFilter.value)
})

// Why the grid is empty. The catalog only lists the friends that answered, so the
// configured friends (from the settings stream) tell "no friends" apart from "none
// reachable". Until that stream's first snapshot arrives the page keeps loading.
type EmptyKind = 'checking' | 'no-friends' | 'unreachable' | 'nothing-shared' | 'filter'
const emptyKind = computed<EmptyKind | null>(() => {
  const catalog = data.value
  if (!catalog || titles.value.length > 0)
    return null
  if (catalog.titles.length > 0)
    return 'filter'
  const friends = settings.value?.peers
  if (!friends)
    return 'checking'
  if (friends.length === 0)
    return 'no-friends'
  return catalog.peers.length === 0 ? 'unreachable' : 'nothing-shared'
})
const unreachableCopy = computed(() => {
  const friends = settings.value?.peers ?? []
  return friends.length === 1
    ? `${friends[0]!.name}'s jack can't be reached right now.`
    : 'Your friends\' jacks can\'t be reached right now.'
})

// Shared by the skeletons and the real cards so both lay out the same.
const gridClass = 'grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]'

function titleName(title: CatalogTitle): string {
  return title.metadata?.title ?? entryFor(title)?.data?.title ?? title.displayTitle
}

const selected = ref<CatalogTitle | null>(null)

const requestOpen = ref(false)
const requestTitle = ref<CatalogTitle | null>(null)
const requestPeerId = ref<string | undefined>(undefined)
const requestSubmitting = ref(false)
const requestError = ref<string | null>(null)

function openRequest(peerId: string) {
  requestTitle.value = selected.value
  requestPeerId.value = peerId
  requestError.value = null
  requestOpen.value = true
}

async function onConfirm(payload: CatalogRequestPayload) {
  const title = requestTitle.value
  if (!title)
    return
  requestSubmitting.value = true
  requestError.value = null
  try {
    await request('catalog/request', {
      method: 'POST',
      body: {
        ...payload,
        mediaType: title.mediaType,
        tmdbId: title.tmdbId,
        tvdbId: title.tvdbId,
      },
    })
    requestOpen.value = false
    selected.value = null
    const peerName = title.peers.find(p => p.id === payload.peerId)?.name ?? 'a friend'
    toast.add({
      title: 'Added to your library',
      description: `"${titleName(title)}" is downloading from ${peerName}.`,
      color: 'success',
      icon: 'i-ph-check-circle',
    })
  }
  catch (err) {
    requestError.value = extractError(err, 'Could not request this title.')
  }
  finally {
    requestSubmitting.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="catalog">
    <template #header>
      <UDashboardNavbar title="Friends' library">
        <template #right>
          <span v-if="updatedAgo" class="hidden text-xs text-muted sm:inline">Updated {{ updatedAgo }} ago</span>
          <UButton icon="i-ph-arrows-clockwise" size="sm" color="neutral" variant="ghost" aria-label="Refresh your friends' library" :loading="refreshing" @click="refreshCatalog" />
          <UTabs
            v-model="typeFilter"
            size="sm"
            :items="[{ label: 'All', value: 'all' }, { label: 'Movies', value: 'movie' }, { label: 'TV', value: 'tv' }]"
            :content="false"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- A failed refresh keeps showing the catalog it already has (and toasts). -->
      <LoadErrorAlert v-if="error && !data" :error="error" :retry="refresh" />

      <!-- Skeletons only until the first catalog arrives: a refresh keeps the grid
           (and the scroll position) and only spins the refresh button. -->
      <div v-else-if="!data || emptyKind === 'checking'" class="space-y-4">
        <p class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-circle-notch" class="size-4 shrink-0 animate-spin" />
          Loading your friends' libraries. The first load can take a minute.
        </p>
        <div :class="gridClass">
          <CatalogPosterCardSkeleton v-for="n in 18" :key="n" />
        </div>
      </div>

      <UCard v-else-if="emptyKind" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <template v-if="emptyKind === 'no-friends'">
            <UIcon name="i-ph-users-three" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">
              Your friends' movies and shows appear here once you've added a friend.
            </p>
            <UButton label="Add a friend" icon="i-ph-plus" :to="settingsLink('peers')" />
          </template>
          <template v-else-if="emptyKind === 'unreachable'">
            <UIcon name="i-ph-wifi-slash" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">
              {{ unreachableCopy }}
            </p>
            <UButton label="See friends" color="neutral" variant="subtle" to="/friends" />
          </template>
          <template v-else-if="emptyKind === 'nothing-shared'">
            <UIcon name="i-ph-film-slate" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">
              Your friends haven't shared any movies or shows yet.
            </p>
            <UButton label="See friends" color="neutral" variant="subtle" to="/friends" />
          </template>
          <template v-else>
            <UIcon name="i-ph-film-slate" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">
              {{ typeFilter === 'tv' ? 'No TV shows from your friends yet.' : 'No movies from your friends yet.' }}
            </p>
            <UButton label="Show all" color="neutral" variant="subtle" @click="typeFilter = 'all'" />
          </template>
        </div>
      </UCard>

      <div v-else :class="gridClass">
        <CatalogPosterCard
          v-for="title in titles"
          :key="title.key"
          :title="title"
          @select="selected = title"
        />
      </div>
    </template>
  </UDashboardPanel>

  <USlideover
    :open="selected !== null"
    :title="selected ? titleName(selected) : 'Title'"
    @update:open="(open) => { if (!open) selected = null }"
  >
    <template #body>
      <CatalogTitleDetail v-if="selected" :title="selected" @download="openRequest" />
    </template>
  </USlideover>

  <DownloadRequestModal
    v-model:open="requestOpen"
    :title="requestTitle"
    :locked-peer-id="requestPeerId"
    :submitting="requestSubmitting"
    :error="requestError"
    @confirm="onConfirm"
  />
</template>
