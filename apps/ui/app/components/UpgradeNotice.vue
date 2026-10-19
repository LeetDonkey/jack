<script setup lang="ts">
import { changedSettingLine, noticesToShow } from '~/utils/upgrade-notice'

// Settings whose default changed in an update, for an install that existed before
// it and never set them (overview.system.notices). The layout renders this under
// the restart banner on every page, until the user dismisses it or saves the
// settings (jack then drops them from the notice).
const { overview, refresh } = useOverview()
const { request, extractError } = useManagement()
const toast = useToast()
const route = useRoute()

// Hidden right away on Dismiss, before the overview catches up.
const dismissed = ref(new Set<string>())
const notices = computed(() => noticesToShow(overview.value?.system?.notices, dismissed.value)
  .map(notice => ({ id: notice.id, lines: notice.changed.map(changedSettingLine) })))

// The banner sits above the page and never scrolls away, so on a small screen
// (phones, also on their side) the list is folded behind "Show what changed". The
// `roomy` variant (main.css) always shows it. Opening a link or another page folds
// it again, so the setting the link points to has the room.
const expanded = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id))
    next.add(id)
  expanded.value = next
}
function collapse() {
  if (expanded.value.size)
    expanded.value = new Set()
}
watch(() => route.fullPath, collapse)

const dismissing = ref<string | null>(null)
async function dismiss(id: string) {
  dismissing.value = id
  try {
    await request(`system/notices/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })
    dismissed.value = new Set([...dismissed.value, id])
    await refresh()
  }
  catch (err) {
    toast.add({ title: extractError(err, 'Could not dismiss the notice.'), color: 'error', icon: 'i-ph-warning' })
  }
  finally {
    dismissing.value = null
  }
}
</script>

<template>
  <!-- The first banner in the column also clears the phone's status bar. -->
  <div
    v-if="notices.length"
    class="shrink-0 divide-y divide-info/25 border-b border-info/25 bg-info/10 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] first:pt-[env(safe-area-inset-top)] sm:pr-[max(2rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))]"
  >
    <section v-for="(notice, i) in notices" :key="notice.id" role="status" class="space-y-1 py-2 text-sm">
      <!-- Dismiss sits next to the title on a roomy screen, and next to the
           toggle below it, so the title keeps one line on a phone. -->
      <div class="flex items-start gap-2">
        <UIcon name="i-ph-info" class="mt-0.5 size-4 shrink-0 text-info" />
        <p class="min-w-0 flex-1 font-medium text-highlighted">
          jack's update changed some settings
        </p>
        <UButton label="Dismiss" size="sm" color="neutral" variant="ghost" class="-my-1.5 hidden shrink-0 roomy:inline-flex" :loading="dismissing === notice.id" @click="dismiss(notice.id)" />
      </div>
      <div class="space-y-1 ps-6">
        <div class="flex items-center justify-between gap-2 roomy:hidden">
          <UButton
            :label="expanded.has(notice.id) ? 'Hide what changed' : 'Show what changed'"
            :trailing-icon="expanded.has(notice.id) ? 'i-ph-caret-up' : 'i-ph-caret-down'"
            :aria-expanded="expanded.has(notice.id)"
            :aria-controls="`upgrade-notice-${i}`"
            size="sm"
            color="neutral"
            variant="link"
            class="-my-1.5 px-0 font-medium text-highlighted underline"
            @click="toggle(notice.id)"
          />
          <UButton label="Dismiss" size="sm" color="neutral" variant="ghost" class="-my-1.5 shrink-0" :loading="dismissing === notice.id" @click="dismiss(notice.id)" />
        </div>
        <!-- Opened on a small screen, the list scrolls inside a capped height. -->
        <div
          :id="`upgrade-notice-${i}`"
          class="space-y-1 roomy:block roomy:max-h-none roomy:overflow-visible"
          :class="expanded.has(notice.id) ? 'max-h-[35svh] overflow-y-auto overscroll-contain' : 'hidden'"
        >
          <p class="text-default">
            You hadn't changed these yourself, so they now follow jack's new defaults.
          </p>
          <ul class="list-disc space-y-0.5 pl-5 text-default">
            <li v-for="line in notice.lines" :key="line.text">
              <span>{{ line.detail ? `${line.text} ${line.detail}` : line.text }}</span>
              <ULink :to="line.to" class="ms-1 font-medium whitespace-nowrap text-highlighted underline" :aria-label="`Change: ${line.text}`" @click="collapse">
                <span>Change</span>
              </ULink>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>
