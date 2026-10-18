import type { ComputedRef, InjectionKey, Ref } from 'vue'
import { UnsavedChangesModal } from '#components'

/**
 * Warns before unsaved settings are thrown away. Each Settings tab is a stack of
 * separately saved forms, so an edit made further up is easy to leave behind.
 *
 * The Settings shell (pages/settings.vue) calls `provideUnsavedGuard()` once. Each
 * form calls `useUnsavedGuard().track(label, dirty)` in its setup. While any
 * tracked form is dirty, these ask first: the browser's own prompt on reload or
 * close, and an in-app dialog when leaving Settings or switching to another tab.
 * Moving between sections of the same tab (hash links) doesn't count as leaving.
 */

type DirtyRef = Ref<boolean> | ComputedRef<boolean>

interface UnsavedGuardRegistry {
  add: (label: string, dirty: DirtyRef) => () => void
}

const UNSAVED_GUARD: InjectionKey<UnsavedGuardRegistry> = Symbol('unsaved-guard')

export function provideUnsavedGuard() {
  const forms = shallowReactive(new Set<{ label: string, dirty: DirtyRef }>())

  provide(UNSAVED_GUARD, {
    add(label, dirty) {
      const entry = { label, dirty }
      forms.add(entry)
      return () => forms.delete(entry)
    },
  })

  // In page order, since forms register as they mount. One label per section,
  // even if a section were to register twice.
  const dirtyLabels = computed(() =>
    [...new Set([...forms].filter(form => form.dirty.value).map(form => form.label))],
  )

  // Browsers show their own wording here; the text can't be set.
  function onBeforeUnload(event: BeforeUnloadEvent) {
    if (!dirtyLabels.value.length)
      return
    event.preventDefault()
    // Older browsers only prompt when returnValue is set.
    event.returnValue = ''
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

  const overlay = useOverlay()
  let asking: Promise<boolean> | undefined

  async function confirmLeave(): Promise<boolean> {
    const labels = dirtyLabels.value
    if (!labels.length)
      return true
    // A fresh dialog per question, removed again once it has closed. A second
    // click while it is open waits for the same answer.
    asking ??= Promise.resolve(overlay.create(UnsavedChangesModal, { destroyOnClose: true }).open({ labels }))
      .then(leave => leave === true)
      .finally(() => {
        asking = undefined
      })
    return await asking
  }

  onBeforeRouteLeave(confirmLeave)
  // Tabs are child routes of the page that provides the guard, so switching tabs
  // updates its route instead of leaving it. Only the tab's forms unmount then;
  // a new hash on the same tab keeps them.
  onBeforeRouteUpdate((to, from) => to.path === from.path || confirmLeave())
}

/**
 * For a settings form: `track(label, dirty)` adds the form to the page's guard
 * until the form unmounts. Does nothing outside a page that provides the guard.
 */
export function useUnsavedGuard() {
  const registry = inject(UNSAVED_GUARD, null)

  function track(label: string, dirty: DirtyRef) {
    if (!registry)
      return
    const remove = registry.add(label, dirty)
    onScopeDispose(remove)
  }

  return { track }
}
