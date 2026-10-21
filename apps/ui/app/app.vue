<script setup lang="ts">
const { state, refresh } = useAuth()

// Resolve the auth state once the app is on screen: the BFF probes the management
// API and tells us which state we're in. The first render doesn't wait for it, so
// while /api/ping waits on a jack that hangs (up to 5 seconds), AuthScreen shows
// "Connecting to jack…" instead of a blank page. refresh() never throws: a jack-ui
// server that doesn't answer becomes an error, and AuthScreen keeps checking from there.
onMounted(() => {
  void refresh()
})
</script>

<template>
  <UApp>
    <NuxtLayout v-if="state.status === 'ok'">
      <NuxtPage />
    </NuxtLayout>
    <AuthScreen v-else />
  </UApp>
</template>
