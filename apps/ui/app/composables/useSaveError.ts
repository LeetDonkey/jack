/** What a save that failed because jack wasn't answering says once jack is back. */
const SAVE_AGAIN = 'Not saved, because jack wasn\'t answering. It\'s back now, so you can save again.'

/**
 * A Settings section's save error. `failed` sets it from what the save threw.
 * A message that jack isn't answering is out of date once jack is back, and the
 * edits are still in the form, so it then asks to save again.
 */
export function useSaveError() {
  const { errorInfo } = useManagement()
  const saveError = ref<string | null>(null)
  let unreachable = false

  function failed(err: unknown, message: string) {
    unreachable = isJackUnreachable(errorInfo(err))
    saveError.value = message
  }

  onJackBack(() => {
    if (unreachable && saveError.value)
      saveError.value = SAVE_AGAIN
    unreachable = false
  })

  return { saveError, failed }
}
