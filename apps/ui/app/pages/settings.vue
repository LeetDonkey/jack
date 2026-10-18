<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import { settingsRedirect } from '~/utils/settings-links'

// The Settings shell: one tab per child page under pages/settings/, and the parts
// every tab shares (deep-link scrolling and the unsaved-changes guard).

definePageMeta({
  // Settings used to be one page, so older links and bookmarks such as
  // /settings#bandwidth or /settings#peers name a section that has moved to a tab
  // or to Friends. Send them there before anything renders.
  middleware: [(to) => {
    const target = settingsRedirect(to.path, to.hash)
    if (target)
      return navigateTo(target, { replace: true })
  }],
})

// Sections register their unsaved edits here. Leaving Settings, or switching to
// another tab, with any of them dirty asks first.
provideUnsavedGuard()

const tabs: NavigationMenuItem[] = [
  { label: 'Radarr & Sonarr', to: '/settings', exact: true },
  { label: 'Sharing', to: '/settings/sharing' },
  { label: 'Bandwidth', to: '/settings/bandwidth' },
  { label: 'Notifications', to: '/settings/notifications' },
  { label: 'Advanced', to: '/settings/advanced' },
]

// Deep links (settingsLink()). The tab scrolls inside the dashboard panel body,
// so vue-router's scrollBehavior can't reach the section. A tab and its sections
// load lazily and push the target down as they render, so it is scrolled back
// into view until the layout settles or the user scrolls.
const route = useRoute()
const content = ref<HTMLElement | null>(null)
let stopFollowing: (() => void) | undefined
let scrollRun = 0

async function scrollToHash(hash: string) {
  stopFollowing?.()
  const run = ++scrollRun
  const id = decodeURIComponent(hash.slice(1))
  if (!id)
    return
  await nextTick()
  if (run !== scrollRun)
    return
  const scroll = () => document.getElementById(id)?.scrollIntoView({ block: 'start' })
  scroll()
  if (!content.value)
    return

  const observer = new ResizeObserver(scroll)
  observer.observe(content.value)
  const userInput = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  let timeout: ReturnType<typeof setTimeout> | undefined
  function stop() {
    observer.disconnect()
    clearTimeout(timeout)
    userInput.forEach(type => window.removeEventListener(type, stop))
    stopFollowing = undefined
  }
  timeout = setTimeout(stop, 5_000)
  userInput.forEach(type => window.addEventListener(type, stop, { passive: true }))
  stopFollowing = stop
}

// The panel body is the one scroll container for every tab, so a new tab would
// open at the previous tab's scroll position.
function scrollToTop() {
  stopFollowing?.()
  scrollRun++
  content.value?.closest('[data-slot="body"]')?.scrollTo({ top: 0 })
}

onMounted(() => void scrollToHash(route.hash))
// Every navigation within Settings, including a link to the hash already in the
// URL: vue-router drops that one as a duplicate, so a watch on route.hash would
// never see it, but afterEach still runs. A navigation the unsaved guard stopped
// (Stay) changes nothing.
const stopAfterEach = useRouter().afterEach((to, from, failure) => {
  if (isNavigationFailure(failure, NavigationFailureType.aborted | NavigationFailureType.cancelled))
    return
  if (to.matched[0] !== route.matched[0])
    return
  if (to.hash)
    void scrollToHash(to.hash)
  else if (to.path !== from.path)
    scrollToTop()
})
onBeforeUnmount(() => {
  stopAfterEach()
  stopFollowing?.()
})
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings" />

      <!-- Scrolls sideways when the tabs don't fit (the toolbar is overflow-x-auto),
           so the labels are never cut off. -->
      <UDashboardToolbar>
        <UNavigationMenu :items="tabs" highlight class="-mx-1 shrink-0" :ui="{ item: 'shrink-0' }" />
      </UDashboardToolbar>
    </template>

    <template #body>
      <div ref="content">
        <NuxtPage />
      </div>
    </template>
  </UDashboardPanel>
</template>
