<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { DownloadItem } from '~/types/management'
import type { DownloadAction } from '~/utils/download-actions'

const props = defineProps<{
  download: DownloadItem
  pending?: DownloadAction
  // Buttons with their names next to the icon (mobile cards, where there is no hover).
  labelled?: boolean
}>()

const emit = defineEmits<{
  action: [action: DownloadAction]
}>()

const PRIMARY: Record<Exclude<DownloadAction, 'delete'>, { label: string, icon: string, color: 'neutral' | 'primary' }> = {
  cancel: { label: 'Cancel', icon: 'i-ph-x-circle', color: 'neutral' },
  retry: { label: 'Retry', icon: 'i-ph-arrow-clockwise', color: 'primary' },
}

const actions = computed(() => downloadActionsFor(props.download))
// Cancel or Retry sit in the open; Remove is set apart in the "…" menu, away from them.
const primary = computed(() => actions.value.filter((a): a is Exclude<DownloadAction, 'delete'> => a !== 'delete'))
const busy = computed(() => props.pending !== undefined)

const menu = computed<DropdownMenuItem[][]>(() => actions.value.includes('delete')
  ? [[{ label: 'Remove', icon: 'i-ph-trash', color: 'error', onSelect: () => emit('action', 'delete') }]]
  : [])
</script>

<template>
  <div class="flex items-center justify-end gap-1">
    <template v-for="action in primary" :key="action">
      <UButton
        v-if="labelled"
        :label="PRIMARY[action].label"
        :icon="PRIMARY[action].icon"
        :color="PRIMARY[action].color"
        :loading="pending === action"
        :disabled="busy"
        variant="soft"
        size="sm"
        @click="emit('action', action)"
      />
      <UTooltip v-else :text="PRIMARY[action].label">
        <UButton
          :aria-label="`${PRIMARY[action].label} ${download.filename}`"
          :icon="PRIMARY[action].icon"
          :color="PRIMARY[action].color"
          :loading="pending === action"
          :disabled="busy"
          variant="ghost"
          size="sm"
          @click="emit('action', action)"
        />
      </UTooltip>
    </template>

    <UDropdownMenu v-if="menu.length" :items="menu" :content="{ align: 'end' }" :disabled="busy">
      <UButton
        :aria-label="`More actions for ${download.filename}`"
        icon="i-ph-dots-three"
        color="neutral"
        variant="ghost"
        size="sm"
        :loading="pending === 'delete'"
        :disabled="busy"
      />
    </UDropdownMenu>
  </div>
</template>
