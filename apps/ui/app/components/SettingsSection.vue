<script setup lang="ts">
const props = defineProps<{
  title: string
  description?: string
  // Anchor for deep links (`settingsLink()`); defaults to a slug of the title.
  id?: string
}>()

const NON_SLUG = /[^a-z0-9]+/g
const EDGE_DASHES = /^-|-$/g
const anchor = computed(() => props.id ?? props.title.toLowerCase().replace(NON_SLUG, '-').replace(EDGE_DASHES, ''))
</script>

<template>
  <section :id="anchor" class="flex scroll-mt-6 flex-col gap-x-8 gap-y-4 lg:flex-row">
    <div class="lg:w-72 lg:shrink-0">
      <h2 class="text-sm font-semibold text-highlighted">
        {{ title }}
      </h2>
      <p v-if="description" class="mt-1 text-xs text-muted">
        {{ description }}
      </p>
      <div v-if="$slots.aside" class="mt-3">
        <slot name="aside" />
      </div>
    </div>

    <div class="min-w-0 flex-1">
      <slot />
    </div>
  </section>
</template>
