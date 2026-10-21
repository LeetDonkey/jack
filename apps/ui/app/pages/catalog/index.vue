<script setup lang="ts">
import type { ActivityCatalogResponse, ActivityCatalogTitle, CatalogRequestOptions, CatalogRequestResult } from '~/types/activity'
import type { CatalogRequestPayload } from '~/types/management'
import type { CatalogSort } from '~/utils/catalog'

const { request, extractError } = useManagement()
const { entryFor } = useCatalogMetadata()
const toast = useToast()

// Lazy (no top-level await) so navigation into the page is instant; the grid shows
// skeletons until the first catalog arrives.
const { data, error, refresh } = useLazyAsyncData(
  'peer-catalog',
  () => request<ActivityCatalogResponse>('catalog'),
)

// Peer catalogs are cached on the server for 15 minutes; the refresh button asks the
// peers again. It fetches outside the async data, because a failed asyncData refresh
// empties `data`: this way a failed refresh keeps the grid and only toasts.
const refreshing = ref(false)
async function refreshCatalog() {
  refreshing.value = true
  try {
    data.value = await request<ActivityCatalogResponse>('catalog?refresh=true')
    error.value = undefined
  }
  catch (err) {
    toast.add({ color: 'error', title: extractError(err, 'Could not refresh your friends\' library.') })
  }
  finally {
    refreshing.value = false
  }
}

// "Updated 5m ago" and "from 3 h ago" have to move on their own; the clock ticks.
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
const peerColors = computed(() => settings.value?.peerColors ?? new Map())
providePeerColors(peerColors)
const dotClass = (id: string) => peerColors.value.get(id)?.dot ?? peerColorClass(id)

// ── Search, filters and sort ────────────────────────────────────────────────

const search = ref('')
const typeFilter = ref<'all' | 'movie' | 'tv'>('all')
const TYPE_TABS = [{ label: 'All', value: 'all' }, { label: 'Movies', value: 'movie' }, { label: 'TV', value: 'tv' }]

// The sort is remembered in this browser.
const SORT_KEY = 'jack:catalog:sort'
function readSort(): CatalogSort {
  try {
    const stored = localStorage.getItem(SORT_KEY)
    return isCatalogSort(stored) ? stored : 'added'
  }
  catch {
    return 'added'
  }
}
const sort = ref<CatalogSort>(readSort())
watch(sort, (value) => {
  try {
    localStorage.setItem(SORT_KEY, value)
  }
  catch {}
})
const sortItems = CATALOG_SORTS.map(option => ({ label: option.label, value: option.value }))

// Friend chips, once there is more than one friend to choose between.
const friendFilter = ref<string>('all')
const catalogFriends = computed(() => data.value?.peers ?? [])
const showFriendChips = computed(() => catalogFriends.value.length >= 2)
watch(catalogFriends, (friends) => {
  if (friendFilter.value !== 'all' && !friends.some(f => f.id === friendFilter.value))
    friendFilter.value = 'all'
})
const friendFilterName = computed(() => catalogFriends.value.find(f => f.id === friendFilter.value)?.name ?? null)

const sorted = computed(() => sortCatalogTitles(data.value?.titles ?? [], sort.value))
const titles = computed(() => {
  const query = search.value.trim()
  return sorted.value.filter((title) => {
    if (typeFilter.value !== 'all' && title.mediaType !== typeFilter.value)
      return false
    if (friendFilter.value !== 'all' && !titleFromFriend(title, friendFilter.value))
      return false
    if (!query)
      return true
    // The names the card may show: the friend's, TMDB's, and the release's own.
    const tmdb = entryFor(title)?.data
    return matchesCatalogSearch({ names: [title.displayTitle, title.metadata?.title, tmdb?.title], year: title.metadata?.year ?? tmdb?.year }, query)
  })
})
const filtering = computed(() => Boolean(search.value.trim()) || typeFilter.value !== 'all' || friendFilter.value !== 'all')

function clearFilters() {
  search.value = ''
  typeFilter.value = 'all'
  friendFilter.value = 'all'
}

// ── Friends that are offline or missing ─────────────────────────────────────

const freshnessNotes = computed(() => catalogFreshnessNotes(data.value?.peers ?? [], clock.value))
// A warning next to Download for a friend whose library may be out of date.
const peerWarnings = computed(() => Object.fromEntries(freshnessNotes.value.map(note => [note.peerId, note.warning])))
const unavailable = computed(() => data.value?.unavailable ?? [])
const unavailableTitle = computed(() => unavailable.value.length === 1
  ? `${unavailable.value[0]!.name}'s library can't be shown right now.`
  : `${unavailable.value.length} friends' libraries can't be shown right now.`)

// Why the grid is empty. The catalog lists the friends that answered and the ones
// that didn't, which tells "no friends" apart from "none reachable".
type EmptyKind = 'no-friends' | 'unreachable' | 'nothing-shared' | 'filter'
const emptyKind = computed<EmptyKind | null>(() => {
  const catalog = data.value
  if (!catalog || titles.value.length > 0)
    return null
  if (catalog.titles.length > 0)
    return 'filter'
  if (catalog.peers.length === 0)
    return (catalog.unavailable?.length ?? 0) > 0 ? 'unreachable' : 'no-friends'
  return 'nothing-shared'
})
// With no friends there is nothing to search, filter, sort or date: the empty
// state's Add a friend is the page.
const noFriends = computed(() => emptyKind.value === 'no-friends')
const unreachableCopy = computed(() => unavailable.value.length === 1
  ? `${unavailable.value[0]!.name}'s jack can't be reached right now.`
  : 'Your friends\' jacks can\'t be reached right now.')
const filterEmptyCopy = computed(() => {
  const query = search.value.trim()
  if (query)
    return `Nothing matches "${query}".`
  const what = typeFilter.value === 'tv' ? 'TV shows' : typeFilter.value === 'movie' ? 'movies' : 'movies or shows'
  return `No ${what} from ${friendFilterName.value ?? 'your friends'} yet.`
})

// Shared by the skeletons and the real cards so both lay out the same.
const gridClass = 'grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]'

function titleName(title: ActivityCatalogTitle): string {
  return title.metadata?.title ?? entryFor(title)?.data?.title ?? title.displayTitle
}

// ── Requests ────────────────────────────────────────────────────────────────

// The title open in the side panel.
const selected = ref<ActivityCatalogTitle | null>(null)

// Where a title can be sent, and whether downloads run. Loaded with the page and
// again whenever a title opens, so a setting changed meanwhile shows. A failed
// reload keeps the last answer.
const requestOptions = ref<CatalogRequestOptions | null>(null)
const requestOptionsStatus = ref<'idle' | 'loading' | 'error'>('idle')
async function loadRequestOptions() {
  if (requestOptionsStatus.value === 'loading')
    return
  requestOptionsStatus.value = 'loading'
  try {
    requestOptions.value = await request<CatalogRequestOptions>('catalog/request-options')
    requestOptionsStatus.value = 'idle'
  }
  catch {
    requestOptionsStatus.value = 'error'
  }
}
onMounted(() => void loadRequestOptions())

// request-options leaves out a Radarr/Sonarr jack can't reach; the overview still
// lists it, so the reason can name it.
const { overview } = useOverview()
const requestGate = computed(() => selected.value
  ? catalogRequestGate(requestOptions.value, selected.value.mediaType, overview.value?.servers.items ?? [])
  : null)

watch(selected, (title) => {
  if (title)
    void loadRequestOptions()
})

const requestOpen = ref(false)
const requestTitle = ref<ActivityCatalogTitle | null>(null)
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
    const result = await request<CatalogRequestResult>('catalog/request', {
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
    const peerName = title.peers.find(p => p.id === payload.peerId)?.name ?? 'your friend'
    const copy = catalogRequestToast(result, title.mediaType, peerName)
    toast.add({
      title: copy.title,
      description: copy.description,
      color: copy.fresh ? 'success' : 'neutral',
      icon: copy.fresh ? 'i-ph-check-circle' : 'i-ph-info',
      actions: [{ label: 'View downloads', to: '/downloads', color: 'neutral', variant: 'outline' }],
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
          <!-- Below 360 px "Updated" would cut off the title. -->
          <span v-if="updatedAgo && !noFriends" class="text-xs whitespace-nowrap text-muted"><span class="hidden min-[360px]:inline">Updated </span>{{ updatedAgo }} ago</span>
          <UInput
            v-if="!noFriends"
            v-model="search"
            type="search"
            icon="i-ph-magnifying-glass"
            placeholder="Search titles or years"
            aria-label="Search your friends' library"
            size="sm"
            class="hidden w-48 sm:block lg:w-64"
          />
          <UButton icon="i-ph-arrows-clockwise" size="sm" color="neutral" variant="ghost" aria-label="Refresh your friends' library" :loading="refreshing" @click="refreshCatalog" />
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar v-if="!noFriends">
        <div class="flex w-full flex-wrap items-center gap-2 py-2">
          <!-- On a phone the search gets a row of its own. -->
          <UInput
            v-model="search"
            type="search"
            icon="i-ph-magnifying-glass"
            placeholder="Search titles or years"
            aria-label="Search your friends' library"
            class="w-full sm:hidden"
          />
          <!-- Inactive tabs in text-toned in light mode: text-muted on the tab list's
               bg-elevated is only 4.4:1. -->
          <UTabs v-model="typeFilter" size="sm" :items="TYPE_TABS" :content="false" :ui="{ trigger: 'data-[state=inactive]:text-toned dark:data-[state=inactive]:text-muted' }" />
          <USelect
            v-model="sort"
            :items="sortItems"
            size="sm"
            icon="i-ph-sort-descending"
            aria-label="Sort by"
            class="ml-auto w-44"
          />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <!-- A failed refresh keeps showing the catalog it already has (and toasts). -->
      <LoadErrorAlert v-if="error && !data" :error="error" :retry="refresh" />

      <!-- Skeletons only until the first catalog arrives: a refresh keeps the grid
           (and the scroll position) and only spins the refresh button. -->
      <div v-else-if="!data" class="space-y-4">
        <p class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-circle-notch" class="size-4 shrink-0 animate-spin" />
          Loading your friends' libraries. The first load can take a minute.
        </p>
        <div :class="gridClass">
          <CatalogPosterCardSkeleton v-for="n in 18" :key="n" />
        </div>
      </div>

      <template v-else>
        <!-- Friends whose library here may be out of date, and friends missing from it. -->
        <div v-if="freshnessNotes.length || (unavailable.length && emptyKind !== 'unreachable')" class="space-y-2">
          <UAlert
            v-for="note in freshnessNotes"
            :key="note.peerId"
            color="warning"
            variant="subtle"
            icon="i-ph-clock-counter-clockwise"
            :title="note.message"
          />
          <UAlert
            v-if="unavailable.length && emptyKind !== 'unreachable'"
            color="neutral"
            variant="subtle"
            icon="i-ph-wifi-slash"
            :title="unavailableTitle"
            :actions="[{ label: 'See friends', to: '/friends', color: 'neutral', variant: 'outline', size: 'sm' }]"
          >
            <template #description>
              <ul class="space-y-0.5">
                <li v-for="line in unavailableFriendLines(unavailable)" :key="line" class="break-words">
                  {{ line }}
                </li>
              </ul>
            </template>
          </UAlert>
        </div>

        <!-- Friend chips, with two or more friends. Wraps on a phone. -->
        <div v-if="showFriendChips" class="flex flex-wrap items-center gap-2">
          <UButton
            label="All friends"
            size="sm"
            color="neutral"
            :variant="friendFilter === 'all' ? 'subtle' : 'ghost'"
            :aria-pressed="friendFilter === 'all'"
            @click="friendFilter = 'all'"
          />
          <UButton
            v-for="friend in catalogFriends"
            :key="friend.id"
            size="sm"
            color="neutral"
            :variant="friendFilter === friend.id ? 'subtle' : 'ghost'"
            :aria-pressed="friendFilter === friend.id"
            class="max-w-48"
            @click="friendFilter = friend.id"
          >
            <span class="size-2 shrink-0 rounded-full" :class="dotClass(friend.id)" />
            <span class="truncate">{{ friend.name }}</span>
          </UButton>
          <span v-if="filtering && titles.length" class="ml-auto text-xs tabular-nums text-muted">
            {{ titles.length }} of {{ data.titles.length }}
          </span>
        </div>
        <p v-else-if="filtering && titles.length" class="text-xs tabular-nums text-muted">
          {{ titles.length }} of {{ data.titles.length }}
        </p>

        <UCard v-if="emptyKind" variant="subtle">
          <div class="flex flex-col items-center gap-3 py-6 text-center">
            <template v-if="emptyKind === 'no-friends'">
              <UIcon name="i-ph-users-three" class="size-8 text-dimmed" />
              <p class="text-sm text-muted">
                Your friends' movies and shows appear here once you've added a friend.
              </p>
              <UButton label="Add a friend" icon="i-ph-user-plus" to="/friends?action=add" />
            </template>
            <template v-else-if="emptyKind === 'unreachable'">
              <UIcon name="i-ph-wifi-slash" class="size-8 text-dimmed" />
              <p class="text-sm text-muted">
                {{ unreachableCopy }}
              </p>
              <ul class="max-w-md space-y-0.5 text-xs text-dimmed">
                <li v-for="line in unavailableFriendLines(unavailable)" :key="line" class="break-words">
                  {{ line }}
                </li>
              </ul>
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
              <UIcon :name="search.trim() ? 'i-ph-magnifying-glass' : 'i-ph-film-slate'" class="size-8 text-dimmed" />
              <p class="text-sm break-words text-muted">
                {{ filterEmptyCopy }}
              </p>
              <UButton :label="search.trim() ? 'Clear search' : 'Show all'" color="neutral" variant="subtle" @click="clearFilters" />
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
    </template>
  </UDashboardPanel>

  <USlideover
    :open="selected !== null"
    :title="selected ? titleName(selected) : 'Title'"
    @update:open="(open) => { if (!open) selected = null }"
  >
    <template #body>
      <CatalogTitleDetail
        v-if="selected"
        :title="selected"
        :gate="requestGate"
        :peer-warnings="peerWarnings"
        @download="openRequest"
      />
    </template>
  </USlideover>

  <DownloadRequestModal
    v-model:open="requestOpen"
    :title="requestTitle"
    :locked-peer-id="requestPeerId"
    :options="requestOptions"
    :options-status="requestOptionsStatus"
    :peer-warnings="peerWarnings"
    :submitting="requestSubmitting"
    :error="requestError"
    @confirm="onConfirm"
    @reload-options="loadRequestOptions"
  />
</template>
