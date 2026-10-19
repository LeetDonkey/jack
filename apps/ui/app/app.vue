<script setup lang="ts">
const { state, refresh } = useAuth()

// Resolve the auth state once on load. The BFF probes the management API and
// tells us which state we're in. refresh() never throws: a jack-ui server that
// doesn't answer becomes an error, and AuthScreen keeps checking from there.
await useAsyncData('ping', async () => {
  await refresh()
  return true
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
