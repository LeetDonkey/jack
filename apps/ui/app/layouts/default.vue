<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { state, logout } = useAuth()

// Keeps the shared overview (and its one stream) open on every page while the tab
// is visible; the restart banner reads it, and so can any page.
useOverview()

// Friends have their own page; Radarr/Sonarr and the rest of the configuration live
// under Settings. Daily pages come first, and Logs and Settings form a second group
// below a separator.
const items: NavigationMenuItem[][] = [
  [
    { label: 'Dashboard', icon: 'i-ph-gauge', to: '/', exact: true },
    { label: 'Friends\' library', icon: 'i-ph-film-reel', to: '/catalog' },
    { label: 'Downloads', icon: 'i-ph-download-simple', to: '/downloads' },
    { label: 'Live traffic', icon: 'i-ph-arrows-down-up', to: '/transfers' },
    { label: 'Friends', icon: 'i-ph-users-three', to: '/friends' },
  ],
  [
    { label: 'Logs', icon: 'i-ph-scroll', to: '/logs' },
    { label: 'Settings', icon: 'i-ph-gear-six', to: '/settings' },
  ],
]

const helpUrl = docsUrl('unraid')
const ENV_SIGN_IN = 'Signed in automatically'
const ENV_KEY_FROM = 'key from the jack-ui template'

// The browser tab names the page with its label here, as in "Logs · jack".
const route = useRoute()
const pageLabel = computed(() => items.flat().find(({ to, exact }) => typeof to === 'string'
  && (route.path === to || (!exact && route.path.startsWith(`${to}/`))))?.label)
useHead({ title: computed(() => pageLabel.value ? `${pageLabel.value} · jack` : 'jack') })

const loggingOut = ref(false)
async function onLogout() {
  loggingOut.value = true
  try {
    await logout()
  }
  finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <UDashboardGroup unit="rem" storage-key="jack-dashboard">
    <!-- A page loads its data before it shows, so a click in the sidebar can take
         a while when jack is slow or away. This bar shows that it's on its way.
         It sits here and not in app.vue because only a mounted page ends it: on
         the sign-in screen a Back or Forward would start it and leave it there.
         When this layout goes away (sign-out, a 401), the bar goes with it. -->
    <NuxtLoadingIndicator color="var(--ui-primary)" />
    <UDashboardSidebar collapsible :default-size="13">
      <template #header="{ collapsed }">
        <NuxtLink v-if="!collapsed" to="/" class="flex min-w-0 items-center gap-2.5">
          <UIcon name="i-ph-plugs-connected" class="size-6 shrink-0 text-primary" />
          <span class="truncate text-base font-semibold tracking-tight text-highlighted">jack</span>
        </NuxtLink>
        <UDashboardSidebarCollapse icon="i-ph-sidebar-simple" :class="collapsed ? 'mx-auto' : 'ms-auto'" />
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu :collapsed="collapsed" :items="items" orientation="vertical" :ui="{ separator: 'my-2' }" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full flex-col gap-1">
          <UButton
            :to="helpUrl"
            target="_blank"
            :label="collapsed ? undefined : 'Help & guide'"
            :aria-label="collapsed ? 'Help & guide' : undefined"
            icon="i-ph-question"
            color="neutral"
            variant="ghost"
            :block="!collapsed"
            :class="!collapsed && 'justify-start'"
          />
          <div class="flex w-full items-center gap-1.5" :class="collapsed ? 'flex-col' : ''">
            <UButton
              v-if="state.mode === 'cookie'"
              :label="collapsed ? undefined : 'Sign out'"
              icon="i-ph-sign-out"
              color="neutral"
              variant="ghost"
              :loading="loggingOut"
              :block="!collapsed"
              :class="!collapsed && 'flex-1 justify-start'"
              @click="onLogout"
            />
            <!-- Env mode: the BFF injects the key, so there is nothing to sign out of.
                 The open sidebar says so next to the padlock, since a phone shows no
                 tooltip; the tooltip adds where the key comes from. -->
            <UTooltip v-else :text="`${ENV_SIGN_IN} (${ENV_KEY_FROM})`" :content="{ side: 'top' }">
              <span
                tabindex="0"
                class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted focus-visible:outline-2 focus-visible:outline-primary"
                :class="!collapsed && 'min-w-0 flex-1'"
              >
                <UIcon name="i-ph-lock-key" class="size-5 shrink-0" />
                <span :class="collapsed ? 'sr-only' : 'text-xs leading-tight'">{{ ENV_SIGN_IN }}<span class="sr-only"> ({{ ENV_KEY_FROM }})</span></span>
              </span>
            </UTooltip>
            <UColorModeButton />
          </div>
        </div>
      </template>
    </UDashboardSidebar>

    <!-- The page column: the restart banner, the "jack isn't answering" notice
         and the update notice on top, then the page's UDashboardPanel. The
         panel's own min-h-svh is reset, or the panel would be the banners'
         height taller than the screen and its last lines unreachable. -->
    <div class="flex min-w-0 flex-1 flex-col">
      <RestartBanner />
      <JackDownNotice />
      <UpgradeNotice />
      <div class="flex min-h-0 flex-1 *:min-h-0">
        <slot />
      </div>
    </div>
  </UDashboardGroup>
</template>
