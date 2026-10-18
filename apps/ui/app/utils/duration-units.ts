/**
 * Duration settings are stored in milliseconds, which is what the config file
 * holds, but edited in seconds, minutes or hours. Going back to the config,
 * values are rounded to whole milliseconds: the backend only accepts integers.
 */
export type DurationUnit = 's' | 'min' | 'h'

export const DURATION_UNIT_MS: Record<DurationUnit, number> = {
  s: 1000,
  min: 60_000,
  h: 3_600_000,
}

// The word shown after the number in the field.
export const DURATION_UNIT_WORDS: Record<DurationUnit, string> = {
  s: 'seconds',
  min: 'minutes',
  h: 'hours',
}

// The number input shows at most three decimals (Intl's default), so the shown
// value is rounded the same way. A value read back from the field then compares
// equal to this and doesn't count as an edit.
const DECIMALS = 1000

/** Milliseconds as the number the field shows, e.g. 90_000 ms in `min` is 1.5. */
export function msToUnit(ms: number, unit: DurationUnit): number {
  return Math.round((ms / DURATION_UNIT_MS[unit]) * DECIMALS) / DECIMALS
}

/** A typed number back to whole milliseconds, e.g. 1.5 `min` is 90_000. */
export function unitToMs(value: number, unit: DurationUnit): number {
  return Math.round(value * DURATION_UNIT_MS[unit])
}

/**
 * A minimum in milliseconds as the smallest number the field accepts. Rounded up,
 * so the smallest allowed entry never converts back to less than the minimum.
 */
export function minInUnit(ms: number, unit: DurationUnit): number {
  return Math.ceil((ms / DURATION_UNIT_MS[unit]) * DECIMALS) / DECIMALS
}
