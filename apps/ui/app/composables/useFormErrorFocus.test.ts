import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { nextTick, ref } from 'vue'
import { useFormErrorFocus } from './useFormErrorFocus'

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

// A form element with one field showing an error, as far as onError looks.
function fakeFormElement() {
  const calls: string[] = []
  const element = (methods: Record<string, unknown>) => Object.assign(Object.create(HTMLElement.prototype), methods)
  const input = element({ focus: () => calls.push('focus') })
  const field = element({
    scrollIntoView: () => calls.push('scroll'),
    querySelector: () => input,
  })
  const message = element({ parentElement: { closest: () => field } })
  const root = element({ querySelector: () => message })
  return { root, calls }
}

describe('useFormErrorFocus', () => {
  test('scrolls to the field at once, and focuses it once the submit is over', async () => {
    const { root, calls } = fakeFormElement()
    const submitting = ref(true)
    const form = {
      $el: root,
      get loading() {
        return submitting.value
      },
      getErrors: () => [{ name: 'rssMaxAgeDays', message: 'Too small' }],
    }
    const { onError } = useFormErrorFocus(form)
    const done = onError()
    await nextTick()
    await nextTick()
    // UForm keeps its inputs disabled while the submit runs.
    expect(calls).toEqual(['scroll'])
    submitting.value = false
    await done
    expect(calls).toEqual(['scroll', 'focus'])
  })

  test('focuses right away outside a submit', async () => {
    const { root, calls } = fakeFormElement()
    const { onError } = useFormErrorFocus({ $el: root, loading: false, getErrors: () => [{ name: 'x', message: 'y' }] })
    await onError()
    expect(calls).toEqual(['scroll', 'focus'])
  })
})
