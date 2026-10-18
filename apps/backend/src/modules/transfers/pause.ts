import { PAUSE_INDEFINITE } from '../../lib/config'

/** What a pause stops: `uploads` (sharing with friends) or `downloads` (from friends). */
export const PAUSE_TARGETS = ['uploads', 'downloads'] as const
export type PauseTarget = typeof PAUSE_TARGETS[number]

/** One direction's pause, as the transfers snapshot reports it. */
export interface PauseState {
  paused: boolean
  /** When it resumes by itself (ISO 8601); null when not paused or paused until resumed. */
  until: string | null
  /** Paused until someone resumes it. */
  indefinite: boolean
}

export const NOT_PAUSED: PauseState = { paused: false, until: null, indefinite: false }

/**
 * The pause in force for a stored `pausedUntil` at `now`. A time that has
 * passed, or a value that isn't a time, means not paused.
 */
export function pauseState(pausedUntil: string | null | undefined, now: Date): PauseState {
  if (!pausedUntil)
    return NOT_PAUSED
  if (pausedUntil === PAUSE_INDEFINITE)
    return { paused: true, until: null, indefinite: true }
  const until = Date.parse(pausedUntil)
  if (Number.isNaN(until) || until <= now.getTime())
    return NOT_PAUSED
  return { paused: true, until: new Date(until).toISOString(), indefinite: false }
}

/** Whole seconds until a timed pause ends (at least 1); null when not paused or paused indefinitely. */
export function secondsUntilResume(state: PauseState, now: Date): number | null {
  if (!state.paused || !state.until)
    return null
  return Math.max(1, Math.ceil((Date.parse(state.until) - now.getTime()) / 1000))
}

export function samePause(a: PauseState, b: PauseState): boolean {
  return a.paused === b.paused && a.until === b.until && a.indefinite === b.indefinite
}
