import type { FieldError } from '../utils/server-field-errors'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { nextTick, reactive, ref } from 'vue'
import { useFormErrorFocus } from './useFormErrorFocus'
import { useServerFieldErrors } from './useServerFieldErrors'

const TOO_SMALL = 'Too small: expected number to be >=1'

// useFormErrorFocus checks for an HTMLElement, which Bun doesn't have. Only for
// these tests.
const ownHTMLElement = !('HTMLElement' in globalThis)
beforeAll(() => {
  if (ownHTMLElement)
    Object.assign(globalThis, { HTMLElement: class {} })
})
afterAll(() => {
  if (ownHTMLElement)
    Reflect.deleteProperty(globalThis, 'HTMLElement')
})

// The part of UForm these use. Like UForm, it keeps errors only for fields it
// shows, and `loading` is true while a submit runs.
function fakeForm(fields: string[]) {
  const errors = ref<FieldError[]>([])
  const submitting = ref(false)
  return {
    errors,
    submitting,
    get loading() {
      return submitting.value
    },
    getErrors: () => errors.value,
    setErrors: (list: FieldError[]) => {
      errors.value = list.filter(error => !error.name || fields.includes(error.name))
    },
  }
}

// In the order the Settings sections set them up.
function setup() {
  const state = reactive({ rssMaxAgeDays: 0 as number | null, rssMaxItems: null as number | null })
  const form = fakeForm(['rssMaxAgeDays', 'rssMaxItems'])
  const focus = useFormErrorFocus(form)
  const serverErrors = useServerFieldErrors(form, name => state[name as keyof typeof state])
  return { state, form, focus, serverErrors }
}

const JACKS = [{ name: 'rssMaxAgeDays', message: TOO_SMALL }]

describe('useServerFieldErrors', () => {
  test('jack\'s error survives the form checking the field again, and so does the fix hint', async () => {
    const { form, focus, serverErrors } = setup()
    serverErrors.show(JACKS)
    await focus.onError()
    expect(focus.showFixHint.value).toBe(true)
    // UForm's check 300 ms after typing: no errors of its own for this field.
    form.errors.value = []
    expect(form.errors.value).toEqual(JACKS)
    await nextTick()
    expect(form.errors.value).toEqual(JACKS)
    expect(focus.showFixHint.value).toBe(true)
  })

  test('the error goes once the field changes, and stays gone', async () => {
    const { state, form, focus, serverErrors } = setup()
    serverErrors.show(JACKS)
    await focus.onError()
    state.rssMaxAgeDays = 3
    await nextTick()
    expect(form.errors.value).toEqual([])
    expect(focus.showFixHint.value).toBe(false)
    state.rssMaxAgeDays = 0
    form.errors.value = []
    await nextTick()
    expect(form.errors.value).toEqual([])
  })

  test('another field\'s edit leaves it alone', async () => {
    const { state, form, serverErrors } = setup()
    serverErrors.show(JACKS)
    state.rssMaxItems = 50
    await nextTick()
    expect(form.errors.value).toEqual(JACKS)
  })

  test('a submit\'s own check runs without it, and a failed check puts it back', async () => {
    const { form, serverErrors } = setup()
    serverErrors.show(JACKS)
    form.submitting.value = true
    form.errors.value = [{ name: 'rssMaxItems', message: 'Enter a number.' }]
    expect(form.errors.value).toEqual([{ name: 'rssMaxItems', message: 'Enter a number.' }])
    form.submitting.value = false
    expect(form.errors.value).toEqual([{ name: 'rssMaxItems', message: 'Enter a number.' }, ...JACKS])
  })

  test('jack\'s answer during the submit shows at once', () => {
    const { form, serverErrors } = setup()
    form.submitting.value = true
    serverErrors.show(JACKS)
    expect(form.errors.value).toEqual(JACKS)
    form.submitting.value = false
    expect(form.errors.value).toEqual(JACKS)
  })

  test('a new answer replaces the earlier one', async () => {
    const { form, serverErrors } = setup()
    serverErrors.show(JACKS)
    const other = [{ name: 'rssMaxAgeDays', message: 'Too big' }]
    serverErrors.show(other)
    expect(form.errors.value).toEqual(other)
    form.errors.value = []
    await nextTick()
    expect(form.errors.value).toEqual(other)
  })

  test('clear() takes jack\'s errors off for a new save or a revert', async () => {
    const { form, serverErrors } = setup()
    serverErrors.show(JACKS)
    serverErrors.clear()
    expect(form.errors.value).toEqual([])
    form.errors.value = []
    await nextTick()
    expect(form.errors.value).toEqual([])
  })

  test('an error for a field the form doesn\'t show isn\'t kept', async () => {
    const { form, serverErrors } = setup()
    serverErrors.show([{ name: 'hidden', message: TOO_SMALL }])
    form.errors.value = []
    await nextTick()
    expect(form.errors.value).toEqual([])
  })
})
