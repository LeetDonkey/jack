<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
import type { ApiKey, ApiKeyInput, CreatedApiKey, FriendsSnapshot } from '~/types/management'

// Keys that belong to no friend: not linked to a peer, not made by an invite link
// or an introduction, and never used for friends-of-friends mail. Friends' keys
// live on their cards on the Friends page.
const { request, extractError, extractFieldError } = useManagement()

const { data, pending, error, refresh } = useLazyAsyncData('other-keys', async () => {
  const [friends, keys] = await Promise.all([
    request<FriendsSnapshot>('friends'),
    request<ApiKey[]>('api-keys'),
  ])
  const loose = new Map(friends.unlinked.keys.map(key => [key.id, key]))
  return keys
    .filter(key => loose.has(key.id))
    .map(key => ({ ...key, usage: loose.get(key.id)! }))
})

const keys = computed(() => data.value ?? [])
type OtherKey = (typeof keys.value)[number]

const now = ref(new Date())
watch(data, () => {
  now.value = new Date()
})

// Expiration as an at-a-glance signal rather than a raw timestamp.
function expiryInfo(key: ApiKey): { label: string, color: BadgeProps['color'] } | null {
  if (!key.expiresAt)
    return null
  const ms = new Date(key.expiresAt).getTime() - now.value.getTime()
  if (ms <= 0)
    return { label: 'Expired', color: 'error' }
  const days = Math.ceil(ms / 86_400_000)
  if (days <= 7)
    return { label: `Expires in ${days}d`, color: 'warning' }
  return { label: `Expires ${new Date(key.expiresAt).toLocaleDateString()}`, color: 'neutral' }
}

// ── Create and edit ─────────────────────────────────────────────────────────
const formOpen = ref(false)
const formDirty = ref(false)
const editTarget = ref<ApiKey | null>(null)
const formRevision = ref(0)
const submitting = ref(false)
const formError = ref<string | null>(null)
const formFieldError = ref<{ name: string, message: string } | null>(null)

function openForm(key: ApiKey | null) {
  editTarget.value = key
  formError.value = null
  formFieldError.value = null
  formRevision.value++
  formOpen.value = true
}

const copied = ref(false)
const copyFailed = ref(false)
// The one-time reveal: set after a successful create, cleared when dismissed.
const created = ref<CreatedApiKey | null>(null)
const createdOpen = computed({
  get: () => created.value !== null,
  set: (open) => {
    if (!open) {
      created.value = null
      copied.value = false
      copyFailed.value = false
    }
  },
})

async function submit(input: ApiKeyInput) {
  if (submitting.value)
    return
  submitting.value = true
  formError.value = null
  formFieldError.value = null
  try {
    if (editTarget.value) {
      await request(`api-keys/${editTarget.value.id}`, { method: 'PATCH', body: input })
      formOpen.value = false
    }
    else {
      const key = await request<CreatedApiKey>('api-keys', { method: 'POST', body: input })
      formOpen.value = false
      // Straight to the reveal: this is the only chance to copy it.
      created.value = key
    }
    await refresh()
  }
  catch (err) {
    const field = extractFieldError(err)
    if (field && ['name', 'description', 'expiresAt'].includes(field.name))
      formFieldError.value = field
    else
      formError.value = extractError(err, 'Could not save the key.')
  }
  finally {
    submitting.value = false
  }
}

async function copyKey() {
  if (!created.value)
    return
  copyFailed.value = false
  if (await copyTextToClipboard(created.value.key)) {
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  }
  else {
    copyFailed.value = true
  }
}

// ── Revoke ──────────────────────────────────────────────────────────────────
const revokeTarget = ref<OtherKey | null>(null)
// Kept after the dialog closes so its text doesn't change while it animates out.
const lastRevoke = ref<OtherKey | null>(null)
watch(revokeTarget, (key) => {
  if (key)
    lastRevoke.value = key
})
const revoking = ref(false)
const revokeError = ref<string | null>(null)
const revokeOpen = computed({
  get: () => revokeTarget.value !== null,
  set: (open) => {
    if (!open && !revoking.value) {
      revokeTarget.value = null
      revokeError.value = null
    }
  },
})

async function confirmRevoke() {
  const key = revokeTarget.value
  if (!key || revoking.value)
    return
  revoking.value = true
  revokeError.value = null
  try {
    await request(`api-keys/${key.id}`, { method: 'DELETE' })
    revokeTarget.value = null
    await refresh()
  }
  catch (err) {
    revokeError.value = extractError(err, 'Could not revoke the key.')
  }
  finally {
    revoking.value = false
  }
}

const keyName = (key: ApiKey) => key.name?.trim() || `Key #${key.id}`
</script>

<template>
  <SettingsSection
    id="other-keys"
    title="API keys for other tools"
    description="Keys that aren't on a friend's card. Each key counts as one friend for upload limits. To let a friend download from you, use Invite a friend on the Friends page instead."
  >
    <template #aside>
      <UButton label="Create key" icon="i-ph-plus" color="neutral" variant="outline" @click="openForm(null)" />
    </template>

    <LoadErrorAlert v-if="error && !data" :error="error" :retry="refresh" what="the API keys" />

    <p v-else-if="pending && !data" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UCard v-else-if="keys.length === 0" variant="subtle">
      <p class="text-sm text-muted">
        No other keys. Keys you give friends show on their cards on the
        <ULink to="/friends">
          <span class="underline">Friends page</span>
        </ULink>.
      </p>
    </UCard>

    <div v-else class="space-y-2">
      <UCard v-for="key in keys" :key="key.id" variant="subtle" :ui="{ body: 'p-3 sm:p-4' }">
        <div class="flex items-center gap-3">
          <span class="hidden size-9 shrink-0 items-center justify-center rounded-lg bg-elevated sm:flex">
            <UIcon name="i-ph-key" class="size-4 text-muted" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="truncate font-medium text-default" :title="keyName(key)">{{ keyName(key) }}</span>
              <UBadge v-if="expiryInfo(key)" v-bind="expiryInfo(key)!" variant="subtle" size="sm" />
            </div>
            <p v-if="key.description" class="truncate text-xs text-muted" :title="key.description">
              {{ key.description }}
            </p>
            <p class="text-xs text-muted">
              {{ keyUsage(key.usage, key.createdAt, now) }} · Uploaded {{ formatBytes(key.usage.uploaded.month) }} in 30 days
            </p>
          </div>
          <UButton icon="i-ph-pencil-simple" color="neutral" variant="ghost" size="sm" :aria-label="`Edit ${keyName(key)}`" @click="openForm(key)" />
          <UButton icon="i-ph-trash" color="neutral" variant="ghost" size="sm" :aria-label="`Revoke ${keyName(key)}`" @click="() => { revokeTarget = key }" />
        </div>
      </UCard>
      <p class="text-xs text-muted">
        Is one of these a friend's key?
        <ULink to="/friends" class="underline">
          Link it on the Friends page
        </ULink>
        under Not linked to a friend.
      </p>
    </div>
  </SettingsSection>

  <UModal
    v-model:open="formOpen"
    :title="editTarget ? `Edit ${keyName(editTarget)}` : 'Create an API key'"
    :dismissible="!formDirty && !submitting"
  >
    <template #body>
      <ApiKeyForm
        :key="formRevision"
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        :field-error="formFieldError"
        @submit="submit"
        @cancel="() => { formOpen = false }"
        @dirty="(value) => { formDirty = value }"
      />
    </template>
  </UModal>

  <UModal v-model:open="createdOpen" title="API key created" :dismissible="false" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-warning"
          title="Copy this key now"
          description="This is the only time it's shown. Store it somewhere safe or paste it where it is needed."
        />
        <UFormField :label="created?.name || 'Unnamed key'">
          <UFieldGroup class="w-full">
            <UInput
              :model-value="created?.key"
              readonly
              class="flex-1 font-mono"
              :ui="{ base: 'text-success' }"
              @focus="(event: FocusEvent) => (event.target as HTMLInputElement).select()"
            />
            <UButton
              :icon="copied ? 'i-ph-check' : 'i-ph-copy'"
              :color="copied ? 'success' : 'neutral'"
              variant="subtle"
              :label="copied ? 'Copied' : 'Copy'"
              @click="copyKey"
            />
          </UFieldGroup>
        </UFormField>
        <p v-if="copyFailed" class="text-xs text-warning">
          This browser doesn't let the page copy here. Click the key, then copy it with Ctrl+C (or Cmd+C).
        </p>
      </div>
    </template>
    <template #footer>
      <UButton label="Done" color="neutral" @click="() => { createdOpen = false }" />
    </template>
  </UModal>

  <UModal v-model:open="revokeOpen" :title="`Revoke ${lastRevoke ? keyName(lastRevoke) : 'key'}?`" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        Anything using this key can no longer search or download from you. This can't be undone.
      </p>
      <UAlert v-if="revokeError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="revokeError" />
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="revoking" @click="() => { revokeOpen = false }" />
      <UButton label="Revoke" color="error" :loading="revoking" @click="confirmRevoke" />
    </template>
  </UModal>
</template>
