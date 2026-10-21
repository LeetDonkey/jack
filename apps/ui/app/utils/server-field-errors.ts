// A form field error as UForm keeps it.
export interface FieldError {
  name?: string
  message: string
}

/** jack's verdict on a field after a refused save, with the value it was about. */
export interface KeptFieldError {
  name: string
  message: string
  /** The field's value at the time, as `fieldSnapshot` writes it. */
  value: string
}

export function fieldSnapshot(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined'
}

/** A form value by its field name: `schedule.0.downloadMb` is `state.schedule[0].downloadMb`. */
export function valueAtPath(state: unknown, name: string): unknown {
  return name.split('.').reduce<unknown>(
    (value, key) => (value != null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
    state,
  )
}

const sameError = (a: FieldError, b: FieldError) => a.name === b.name && a.message === b.message

/** The form's errors with `errors` in place of any others on the same fields. */
export function replaceFieldErrors(current: readonly FieldError[], errors: readonly FieldError[]): FieldError[] {
  const names = new Set(errors.map(error => error.name))
  return [...current.filter(error => !error.name || !names.has(error.name)), ...errors]
}

/**
 * The form's errors after it checked a field again: UForm then replaces that
 * field's errors with its own check's result, which knows nothing of jack's.
 * Kept errors go back on, unless their field has changed since, which drops them
 * from both lists. `errors` is null when the form's errors need no change.
 */
export function reconcileFieldErrors(
  current: readonly FieldError[],
  kept: readonly KeptFieldError[],
  snapshotOf: (name: string) => string,
): { kept: KeptFieldError[], errors: FieldError[] | null } {
  const valid = kept.filter(error => snapshotOf(error.name) === error.value)
  const stale = kept.filter(error => !valid.includes(error))
  const remaining = current.filter(error => !stale.some(old => sameError(old, error)))
  const missing = valid.filter(error => !remaining.some(shown => sameError(error, shown)))
  if (!missing.length && remaining.length === current.length)
    return { kept: valid, errors: null }
  return { kept: valid, errors: [...remaining, ...missing.map(({ name, message }) => ({ name, message }))] }
}

/** The form's errors without the kept ones, for a new save or a revert. */
export function withoutKeptErrors(current: readonly FieldError[], kept: readonly KeptFieldError[]): FieldError[] | null {
  const remaining = current.filter(error => !kept.some(old => sameError(old, error)))
  return remaining.length === current.length ? null : remaining
}
