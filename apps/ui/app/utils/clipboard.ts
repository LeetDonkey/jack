// document.execCommand('copy') is deprecated, but it is the only way to copy on a
// page that isn't a secure context (jack-ui opened over plain http by IP).
function copyBySelection(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // An open dialog traps focus: a textarea outside it loses focus the moment it is
  // selected, and then there is nothing to copy. Inside the dialog it keeps it.
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'))
  const host = previous?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
    ?? dialogs.at(-1)
    ?? document.body
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  area.tabIndex = -1
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  area.style.pointerEvents = 'none'
  host.appendChild(area)
  try {
    area.focus({ preventScroll: true })
    area.select()
    return document.execCommand('copy')
  }
  catch {
    return false
  }
  finally {
    area.remove()
    previous?.focus({ preventScroll: true })
  }
}

/**
 * Copy `text` from a click handler. False when the browser refused both ways;
 * the caller then leaves the text selectable for the user to copy by hand.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    }
    catch {
      // Denied: try the old way below.
    }
  }
  return copyBySelection(text)
}
