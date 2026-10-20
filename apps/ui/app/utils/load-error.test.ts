import { describe, expect, test } from 'bun:test'
import { isJackUnreachable, loadErrorText } from './load-error'

// What the BFF answers when jack doesn't: a 503 with its own message and no code.
const BFF_DOWN = { status: 503, code: null, message: 'jack isn\'t answering. Check that the jack container is running (Docker tab).' }

describe('isJackUnreachable', () => {
  test('the BFF\'s 503 and a proxy\'s 502/504 without a jack error code', () => {
    expect(isJackUnreachable(BFF_DOWN)).toBe(true)
    expect(isJackUnreachable({ status: 502, code: null })).toBe(true)
    expect(isJackUnreachable({ status: 504, code: null })).toBe(true)
  })

  test('nothing answered at all', () => {
    expect(isJackUnreachable({ status: undefined, code: null })).toBe(true)
  })

  test('jack answering with an error of its own is not unreachable', () => {
    expect(isJackUnreachable({ status: 503, code: 'CONNECTOR_INITIALIZATION_FAILED' })).toBe(false)
    expect(isJackUnreachable({ status: 500, code: null })).toBe(false)
    expect(isJackUnreachable({ status: 404, code: 'NOT_FOUND' })).toBe(false)
  })
})

describe('loadErrorText', () => {
  test('jack not answering: says so once, without the BFF\'s message', () => {
    const text = loadErrorText(BFF_DOWN)
    expect(text.title).toBe('Can\'t reach jack. It may be restarting.')
    expect(text.description).toBe('Trying again every few seconds. If it stays like this, check that the jack container is running (Docker tab).')
    expect(text.description).not.toContain('isn\'t answering')
  })

  test('a section names what it couldn\'t load', () => {
    expect(loadErrorText(BFF_DOWN, 'the bandwidth settings').title)
      .toBe('Can\'t load the bandwidth settings: jack isn\'t answering. It may be restarting.')
  })

  test('another error shows jack\'s message and that it retries', () => {
    const text = loadErrorText({ status: 500, code: 'INTERNAL', message: 'Database is locked' }, 'the RSS feed settings')
    expect(text.title).toBe('Failed to load the RSS feed settings.')
    expect(text.description).toBe('Database is locked. Trying again every few seconds.')
  })

  test('a message that already ends a sentence keeps its punctuation', () => {
    expect(loadErrorText({ status: 500, code: null, message: 'Something broke!' }).description)
      .toBe('Something broke! Trying again every few seconds.')
  })

  test('without a message, only the retry', () => {
    const text = loadErrorText({ status: 500, code: null, message: null })
    expect(text.title).toBe('Failed to load this page.')
    expect(text.description).toBe('Trying again every few seconds.')
  })
})
