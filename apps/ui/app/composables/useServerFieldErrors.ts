import type { MaybeRefOrGetter } from 'vue'
import type { FieldError, KeptFieldError } from '../utils/server-field-errors'
import { shallowRef, toValue, watch } from 'vue'
import { fieldSnapshot, reconcileFieldErrors, replaceFieldErrors, withoutKeptErrors } from '../utils/server-field-errors'

// What this needs from a UForm template ref.
interface FormHandle {
  getErrors?: () => readonly FieldError[]
  setErrors?: (errors: FieldError[]) => void
  loading?: boolean
}

/**
 * jack's verdict on fields after a refused save, kept on those fields until
 * their value changes. UForm checks a field again 300 ms after typing, and on
 * blur and change, and puts its own result in place of the field's errors, so
 * jack's message would vanish before anyone read it.
 *
 * Usage: `show([{ name, message }])` in a save's catch, `clear()` when a save
 * starts and before a revert.
 */
export function useServerFieldErrors(form: MaybeRefOrGetter<unknown>, valueOf: (name: string) => unknown) {
  const handle = () => toValue(form) as FormHandle | null | undefined
  const kept = shallowRef<KeptFieldError[]>([])
  const snapshotOf = (name: string) => fieldSnapshot(valueOf(name))

  // The form drops errors for fields it doesn't show, so only the ones it took
  // stay kept. Otherwise each put-back would trigger the next. `kept` only
  // changes when the list does, since a change runs the watcher again.
  function keepShown(errors: readonly KeptFieldError[]) {
    const shown = handle()?.getErrors?.() ?? []
    const next = errors.filter(error => shown.some(s => s.name === error.name && s.message === error.message))
    if (next.length !== kept.value.length || next.some((error, i) => error !== kept.value[i]))
      kept.value = next
  }

  // Not during a submit: its check must pass without jack's old verdict, which
  // may be about another field's value, and a save clears it anyway. Should the
  // check fail, the end of the submit puts it back.
  function sync() {
    const f = handle()
    if (!f?.getErrors || !f.setErrors || !kept.value.length || f.loading)
      return
    const result = reconcileFieldErrors(f.getErrors(), kept.value, snapshotOf)
    if (result.errors)
      f.setErrors(result.errors)
    keepShown(result.kept)
  }

  function show(errors: readonly FieldError[]) {
    const f = handle()
    if (!f?.getErrors || !f.setErrors)
      return
    const named = errors.flatMap(({ name, message }) => (name ? [{ name, message }] : []))
    // A new answer replaces jack's earlier verdicts.
    const earlier = kept.value
    kept.value = []
    const current = f.getErrors()
    f.setErrors(replaceFieldErrors(withoutKeptErrors(current, earlier) ?? current, named))
    keepShown(named.map(error => ({ ...error, value: snapshotOf(error.name) })))
  }

  function clear() {
    const f = handle()
    const remaining = f?.getErrors ? withoutKeptErrors(f.getErrors(), kept.value) : null
    kept.value = []
    if (remaining)
      f?.setErrors?.(remaining)
  }

  // Synchronous, so the form never shows its errors without jack's: a moment
  // without any would also clear useFormErrorFocus's "Fix the highlighted
  // fields" hint.
  watch(
    () => (kept.value.length ? [handle()?.getErrors?.(), handle()?.loading, kept.value.map(error => snapshotOf(error.name))] : null),
    sync,
    { flush: 'sync' },
  )

  return { show, clear }
}
