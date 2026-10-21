import type { MaybeRefOrGetter } from 'vue'
import { computed, nextTick, ref, toValue, watch } from 'vue'

// What this needs from a UForm template ref.
interface FormHandle {
  $el?: unknown
  getErrors?: () => readonly unknown[]
  loading?: boolean
}

/**
 * For a UForm with `validate`: a failed submit scrolls to the first field that
 * shows an error and focuses it, and `showFixHint` says why Save did nothing
 * until every highlighted field is fixed.
 *
 * Usage: `<UForm ref="form" @error="onError">` with
 * `const { onError, showFixHint } = useFormErrorFocus(useTemplateRef('form'))`.
 */
export function useFormErrorFocus(form: MaybeRefOrGetter<unknown>) {
  const handle = () => toValue(form) as FormHandle | null | undefined
  const failed = ref(false)
  const errorCount = computed(() => handle()?.getErrors?.().length ?? 0)

  watch(errorCount, (count) => {
    if (count === 0)
      failed.value = false
  })

  const showFixHint = computed(() => failed.value && errorCount.value > 0)

  // jack's refusal arrives while UForm still runs the submit, and UForm keeps
  // every input disabled until the submit returns. A disabled input can't take
  // the focus.
  async function untilSubmitted() {
    if (!handle()?.loading)
      return
    await new Promise<void>((resolve) => {
      const stop = watch(() => handle()?.loading, (loading) => {
        if (loading)
          return
        stop()
        resolve()
      })
    })
    await nextTick()
  }

  async function onError() {
    failed.value = true
    await nextTick()
    const root = handle()?.$el
    if (!(root instanceof HTMLElement))
      return
    // First in page order. Error ids only exist for fields wrapping one input,
    // so a day row or a field holding two inputs is found by its message.
    const message = root.querySelector('[data-slot="error"]')
    const field = message?.parentElement?.closest('[data-orientation]') ?? message
    if (!(field instanceof HTMLElement))
      return
    field.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await untilSubmitted()
    field.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true })
  }

  return { onError, showFixHint }
}
