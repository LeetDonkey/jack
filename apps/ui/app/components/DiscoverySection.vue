<script setup lang="ts">
import type { Form, FormSchema } from '@nuxt/ui'
import type { DiscoveryConfig, DiscoveryConfigPatch } from '~/types/management'

const { request, extractError, extractFieldError } = useManagement()
const form = useTemplateRef<Form<FormSchema>>('form')
const { onError, showFixHint } = useFormErrorFocus(form)

const { data: discovery, pending, error: loadError, refresh } = useLazyAsyncData(
  'discovery-config',
  () => request<DiscoveryConfig | null>('config/discovery'),
)

// Friends of friends see the name friends see (Your public address) unless a
// different name is set here. Shared with that section, so a save there shows here.
const { data: jack } = useJackConfig()
const nameFriendsSee = computed(() => jack.value?.external?.instanceName?.trim() || null)
const overrideDescription = computed(() => nameFriendsSee.value
  ? `Leave empty to use the name friends see, ${nameFriendsSee.value}.`
  : 'Leave empty to use the name friends see.')

function blankState() {
  return { publicName: '', discoverable: false, introduce: false }
}

const state = reactive(blankState())
const baseline = ref(JSON.stringify(blankState()))
// The separate name stays behind its link until someone asks for it or one is saved.
const showOverride = ref(false)

function seed(config: DiscoveryConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    state.publicName = config.publicName ?? ''
    state.discoverable = config.discoverable
    state.introduce = config.introduce
  }
  baseline.value = JSON.stringify(state)
  showOverride.value = Boolean(state.publicName)
}

watch(() => discovery.value, seed, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== baseline.value)
useUnsavedGuard().track('Friends of friends', dirty)
const saving = ref(false)
const { saveError, failed: saveFailed } = useSaveError()
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

const publicNameInput = useTemplateRef<{ inputRef?: HTMLInputElement | null }>('publicNameInput')
async function openOverride() {
  showOverride.value = true
  await nextTick()
  publicNameInput.value?.inputRef?.focus()
}
// Saving then removes the separate name, so friends of friends see the name friends see.
function closeOverride() {
  state.publicName = ''
  showOverride.value = false
  form.value?.clear('publicName')
}

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
    // jack's verdict on the name goes on that field, without its config name.
    const field = extractFieldError(err)
    if (field?.name === 'publicName') {
      // The form only keeps errors for a field it has shown.
      if (!showOverride.value) {
        showOverride.value = true
        await nextTick()
      }
      form.value?.setErrors([field], field.name)
      void onError()
    }
    else {
      saveFailed(err, extractError(err, 'Could not save the friends-of-friends settings.'))
    }
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(discovery.value ?? null)
  form.value?.clear()
  saveError.value = null
  saved.value = false
}
</script>

<template>
  <SettingsSection
    id="friends-of-friends"
    title="Friends of friends"
    description="Let people your friends know find you by name, and ask to connect. Your address stays hidden until you both accept."
  >
    <LoadErrorAlert v-if="loadError" :error="loadError" :retry="refresh" what="the friends-of-friends settings" />

    <p v-else-if="pending && discovery === undefined" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else ref="form" :state="state" class="space-y-3" @submit="save">
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <div v-if="!showOverride" class="space-y-1">
          <p class="text-sm font-medium text-default">
            Name friends of friends see
          </p>
          <p class="text-sm text-muted">
            <template v-if="nameFriendsSee">
              <strong class="font-medium text-highlighted">{{ nameFriendsSee }}</strong>, the name friends see.
            </template>
            <template v-else>
              The name friends see, once you set it under
              <ULink :to="settingsLink('public-address')">
                <span class="underline">Your public address</span>
              </ULink>.
            </template>
          </p>
          <UButton
            label="Use a different name for friends of friends"
            color="neutral"
            variant="link"
            size="sm"
            class="px-0"
            :ui="{ label: 'whitespace-normal text-left underline' }"
            :disabled="saving"
            @click="openOverride"
          />
        </div>

        <UFormField
          v-else
          name="publicName"
          label="Name friends of friends see"
          :description="overrideDescription"
        >
          <UInput
            ref="publicNameInput"
            v-model="state.publicName"
            :disabled="saving"
            :placeholder="nameFriendsSee ?? 'e.g. Bob'"
            maxlength="60"
            class="w-full"
          />
          <template #help>
            <UButton
              label="Use the name friends see instead"
              color="neutral"
              variant="link"
              size="xs"
              class="px-0"
              :ui="{ label: 'underline' }"
              :disabled="saving"
              @click="closeOverride"
            />
          </template>
        </UFormField>

        <UFormField
          name="discoverable"
          label="Let friends of friends find me"
          description="Your friends who introduce show your name to their other friends, who can then ask to connect. They see the name only: no address or anything else that locates you."
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
        description="Each side creates an access key for the other and sends it with its public address, encrypted so only the other person can read it. Both jacks then add each other as friends and connect directly. Until then, every request and message goes through your mutual friend."
      />

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved." description="Applies right away." />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <ULink to="/friends" class="mr-auto text-xs text-muted underline">
          See friends of friends
        </ULink>
        <p v-if="showFixHint" class="text-xs text-error">
          Fix the highlighted fields to save.
        </p>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
