<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'

const props = defineProps<{
  name: string
  url: string
  initialized: boolean
  error?: string | null
  status: { color: BadgeProps['color'], label: string }
  to?: string
  // Optional identity accent (e.g. a peer's derived text-color class) applied to the
  // status icon. Left unset for connectors, which have no per-entry color.
  accentClass?: string | null
}>()
defineEmits<{ edit: [], remove: [] }>()

// Where a URL that has to wrap may break: before the port and before each part of
// the path, so "http://192.168.0.20:7878" doesn't split inside the address or the
// port while a whole part fits on the line. The pieces join back to the URL as given.
const URL_PARTS = /^[a-z][\w+.-]*:\/\/[^/:]*|:\d+|\/[^/]*|[^/:]+|:/gi
const urlParts = computed(() => props.url.match(URL_PARTS) ?? [props.url])
</script>

<template>
  <UCard variant="subtle" :ui="{ body: 'sm:p-4' }">
    <!-- On a phone the badge and buttons go on a row of their own under the name,
         so the URL gets the card's whole width. -->
    <div class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:flex">
      <ConnDot :initialized="initialized" :error="error" :accent-class="accentClass" />
      <div class="min-w-0 sm:flex-1">
        <div class="flex items-baseline gap-2">
          <span class="truncate font-medium text-default" :title="name">{{ name }}</span>
          <slot name="badge" />
        </div>
        <!-- Wraps on a phone, where the hover title can't show the rest. -->
        <p class="font-mono text-xs break-words text-muted sm:truncate" :title="url">
          <template v-for="(part, i) in urlParts" :key="i">
            <wbr v-if="i">{{ part }}
          </template>
        </p>
      </div>
      <div class="col-start-2 flex items-center gap-3 sm:contents">
        <UBadge v-bind="status" variant="subtle" class="mr-auto sm:mr-0" />
        <UButton v-if="to" :to="to" icon="i-ph-list-magnifying-glass" color="neutral" variant="ghost" size="sm" :aria-label="`Browse ${name} catalog`" />
        <UButton icon="i-ph-pencil-simple" color="neutral" variant="ghost" size="sm" :aria-label="`Edit ${name}`" @click="$emit('edit')" />
        <UButton icon="i-ph-trash" color="neutral" variant="ghost" size="sm" :aria-label="`Remove ${name}`" @click="$emit('remove')" />
      </div>
    </div>

    <slot name="meta" />

    <UAlert
      v-if="!initialized && error"
      class="mt-3"
      color="error"
      variant="soft"
      :ui="{ description: 'font-mono text-xs' }"
      :description="error"
    />

    <!-- Below the error: what follows from the connection, such as what jack set up in a Radarr/Sonarr. -->
    <slot name="details" />
  </UCard>
</template>
