import type { PauseState, PauseTarget } from '~/types/tools'

/** The ways to pause the menu offers. `morning` is the next 08:00. */
export type PauseChoice = '1h' | '4h' | 'morning' | 'indefinite'

export const PAUSE_CHOICES: readonly PauseChoice[] = ['1h', '4h', 'morning', 'indefinite']

/** Shown with "Until I resume" for sharing: a friend's jack retries a paused upload for its retry window (24 h by default). */
export const INDEFINITE_SHARING_WARNING = 'Friends\' downloads from you give up after about 24 hours.'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const MORNING_HOUR = 8
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The next 08:00 in the browser's time zone that is at least an hour away, so
 * "Until 08:00" picked at 07:30 means tomorrow morning.
 */
export function nextMorning(now: Date): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), MORNING_HOUR, 0, 0, 0)
  if (at.getTime() - now.getTime() < HOUR_MS)
    at.setDate(at.getDate() + 1)
  return at
}

/** The `until` for POST /transfers/pause: an ISO time, or `indefinite`. */
export function pauseUntil(choice: PauseChoice, now: Date): string {
  switch (choice) {
    case '1h':
      return new Date(now.getTime() + HOUR_MS).toISOString()
    case '4h':
      return new Date(now.getTime() + 4 * HOUR_MS).toISOString()
    case 'morning':
      return nextMorning(now).toISOString()
    case 'indefinite':
      return 'indefinite'
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * A time after `now`, as short as it can be said: "18:30" today, "tomorrow
 * 08:00", "Tue 08:00" within the week, "25 Oct, 08:00" after that.
 */
export function pauseTimeText(at: Date, now: Date): string {
  // Rounded, so a day with a daylight saving change still counts as one day.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS)
  if (days <= 0)
    return clock(at)
  if (days === 1)
    return `tomorrow ${clock(at)}`
  if (days < 7)
    return `${WEEKDAYS[at.getDay()]} ${clock(at)}`
  return `${at.getDate()} ${MONTHS[at.getMonth()]}, ${clock(at)}`
}

/** The menu label for a choice, as it would apply if picked at `now`. */
export function pauseChoiceLabel(choice: PauseChoice, now: Date): string {
  switch (choice) {
    case '1h':
      return 'For 1 hour'
    case '4h':
      return 'For 4 hours'
    case 'morning':
      return `Until ${pauseTimeText(nextMorning(now), now)}`
    case 'indefinite':
      return 'Until I resume'
  }
}

/** Whether a pause is in force at `now`. A timed pause whose time has passed is over, even before jack says so. */
export function isPauseActive(state: PauseState | null | undefined, now: Date): boolean {
  if (!state?.paused)
    return false
  if (state.indefinite || !state.until)
    return true
  const until = Date.parse(state.until)
  return Number.isNaN(until) || until > now.getTime()
}

/** "Sharing paused until 18:30", "Downloads paused until you resume"; null when not paused. */
export function pauseStateText(what: PauseTarget, state: PauseState | null | undefined, now: Date): string | null {
  if (!state || !isPauseActive(state, now))
    return null
  const subject = what === 'uploads' ? 'Sharing' : 'Downloads'
  const until = state.until ? new Date(state.until) : null
  if (state.indefinite || !until || Number.isNaN(until.getTime()))
    return `${subject} paused until you resume`
  return `${subject} paused until ${pauseTimeText(until, now)}`
}
