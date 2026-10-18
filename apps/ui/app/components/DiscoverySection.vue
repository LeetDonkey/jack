<script setup lang="ts">
import type { DiscoveryConfig, DiscoveryConfigPatch } from '~/types/management'

const { request, extractError } = useManagement()

const { data: discovery, pending, error: loadError, refresh } = useLazyAsyncData(
  'discovery-config',
  () => request<DiscoveryConfig | null>('config/discovery'),
)

function blankState() {
  return { publicName: '', discoverable: false, introduce: false }
}

const state = reactive(blankState())
const baseline = ref(JSON.stringify(blankState()))

function seed(config: DiscoveryConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    state.publicName = config.publicName ?? ''
    state.discoverable = config.discoverable
    state.introduce = config.introduce
  }
  baseline.value = JSON.stringify(state)
}

watch(() => discovery.value, seed, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== baseline.value)
useUnsavedGuard().track('Friends of friends', dirty)
const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  const patch: DiscoveryConfigPatch = {
    publicName: state.publicName.trim() || null,
    discoverable: state.discoverable,
    introduce: state.introduce,
  }
  try {
    await request('config/discovery', { method: 'PATCH', body: patch })
    await refresh()
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the friends-of-friends settings.')
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(discovery.value ?? null)
  saveError.value = null
  saved.value = false
}
</script>

<template>
  <SettingsSection
    id="friends-of-friends"
    title="Friends of friends"
    description="Let people your friends know find you by a name you choose, and ask to connect. Your address stays hidden until you both accept."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the friends-of-friends settings." />

    <p v-else-if="pending && discovery === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else :state="state" class="space-y-3" @submit="save">
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <UFormField name="publicName" label="Public name" description="What friends of friends see. Leave empty to use your Instance name from Quick linking.">
          <UInput v-model="state.publicName" :disabled="saving" placeholder="e.g. Bob" maxlength="60" class="w-full" />
        </UFormField>

        <UFormField
          name="discoverable"
          label="Let friends of friends find me"
          description="Your friends who introduce show your public name to their other friends, who can then ask to connect. They see the name only: no URL, address or anything else that locates you."
        >
          <USwitch v-model="state.discoverable" :disabled="saving" />
        </UFormField>

        <UFormField
          name="introduce"
          label="Introduce my friends to each other"
          description="List the friends who chose to be found to your other friends, and carry their requests and messages. Everything you carry is end-to-end encrypted: you can't read it."
        >
          <USwitch v-model="state.introduce" :disabled="saving" />
        </UFormField>
      </UCard>

      <UAlert
        color="neutral"
        variant="soft"
        icon="i-ph-shield-check"
        title="When you both accept"
        description="Each side creates an access key for the other and sends it with its external URL (from Quick linking), encrypted so only the other person can read it. Both jacks then add each other as friends and connect directly. Until then, every request and message goes through your mutual friend."
      />

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="Applies right away." />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <ULink to="/friends" class="mr-auto text-xs text-muted underline">
          See friends of friends
        </ULink>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
