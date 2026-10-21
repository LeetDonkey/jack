<script setup lang="ts">
import type { DurationUnit } from '~/utils/duration-units'

/**
 * One numeric key of the config file. Empty means "not in the file", so jack's own
 * default applies. The placeholder shows that default, and the hint always states
 * the value actually in effect (durations read back as "30 min", not "1800000").
 *
 * With `displayUnit`, the key holds milliseconds but the field is edited in
 * seconds, minutes or hours. `defaultValue`, `min` and `max` stay in milliseconds.
 */
const props = withDefaults(defineProps<{
  /** The config file key, used for the field's name and error mapping. */
  name: string
  label: string
  description?: string
  /** jack's default when the key is absent from the config file. */
  defaultValue: number
  /** `ms` renders the effective value as a duration; `count` leaves it as a number. */
  unit?: 'ms' | 'count'
  /** Edit a millisecond value in this unit instead. Implies `unit: 'ms'`. */
  displayUnit?: DurationUnit
  /** Shown in the hint instead of the value when the value is 0, e.g. "Off". */
  zeroLabel?: string
  min?: number
  /** The largest value jack accepts for this key, where it has one. */
  max?: number
  disabled?: boolean
}>(), { unit: 'count', min: 0 })

const model = defineModel<number | null>()

const isDuration = computed(() => props.unit === 'ms' || Boolean(props.displayUnit))

function readable(value: number) {
  if (value === 0 && props.zeroLabel)
    return props.zeroLabel
  return isDuration.value ? formatDurationMs(value) : String(value)
}

const hint = computed(() =>
  model.value == null ? `Default · ${readable(props.defaultValue)}` : readable(model.value),
)

// The number in the input, in `displayUnit` when one is set.
const inputValue = computed<number | null>({
  get() {
    if (model.value == null)
      return null
    return props.displayUnit ? msToUnit(model.value, props.displayUnit) : model.value
  },
  set(value) {
    // A cleared input reports undefined. The config form needs null for "use
    // jack's default", since an undefined key is left out of the PATCH body and
    // the stored value would stay.
    if (value == null || Number.isNaN(value)) {
      model.value = null
      return
    }
    if (!props.displayUnit) {
      model.value = value
      return
    }
    // The input reports its shown value again on every blur. Converting that back
    // would round a stored value that isn't a whole number of the unit, and make
    // an untouched form look edited.
    if (model.value != null && value === msToUnit(model.value, props.displayUnit))
      return
    model.value = Math.min(props.max ?? Infinity, Math.max(props.min, unitToMs(value, props.displayUnit)))
  },
})

const inputMin = computed(() => (props.displayUnit ? minInUnit(props.min, props.displayUnit) : props.min))
// Rounded down, so the largest allowed entry never converts back to more than the maximum.
const inputMax = computed(() => {
  if (props.max == null || !props.displayUnit)
    return props.max
  return Math.floor((props.max / DURATION_UNIT_MS[props.displayUnit]) * 1000) / 1000
})

const placeholder = computed(() =>
  String(props.displayUnit ? msToUnit(props.defaultValue, props.displayUnit) : props.defaultValue),
)
</script>

<template>
  <UFormField
    :name="name"
    :label="label"
    :description="description"
    :hint="hint"
    :ui="{ hint: 'shrink-0 font-mono text-xs whitespace-nowrap text-dimmed' }"
  >
    <div class="relative">
      <!-- Counts snap to whole numbers. Durations in a display unit take fractions
           (1.5 min); they are rounded to whole milliseconds when converted back. -->
      <UInputNumber
        v-model="inputValue"
        :min="inputMin"
        :max="inputMax"
        :step-snapping="!displayUnit"
        :disabled="disabled"
        :increment="false"
        :decrement="false"
        :placeholder="placeholder"
        class="w-full"
        :ui="displayUnit ? { base: 'pe-20' } : undefined"
      />
      <span
        v-if="displayUnit"
        class="pointer-events-none absolute inset-y-0 end-0 flex items-center pe-3 text-sm text-dimmed"
      >
        {{ DURATION_UNIT_WORDS[displayUnit] }}
      </span>
    </div>
  </UFormField>
</template>
