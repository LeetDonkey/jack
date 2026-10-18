<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { state, logout } = useAuth()

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
const ENV_SIGN_IN = 'Signed in automatically (key from the jack-ui template)'

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
            <!-- Env mode: the BFF injects the key, so there is nothing to sign out of. -->
            <UTooltip v-else :text="ENV_SIGN_IN" :content="{ side: 'top' }">
              <span
                tabindex="0"
                class="flex items-center rounded-md px-2.5 py-1.5 text-muted focus-visible:outline-2 focus-visible:outline-primary"
                :class="!collapsed && 'mr-auto'"
              >
                <UIcon name="i-ph-lock-key" class="size-5" />
                <span class="sr-only">{{ ENV_SIGN_IN }}</span>
              </span>
            </UTooltip>
            <UColorModeButton />
          </div>
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
