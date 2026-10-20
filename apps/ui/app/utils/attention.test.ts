import { describe, expect, test } from 'bun:test'
import { attentionHeading } from './attention'

describe('attentionHeading', () => {
  test('nothing listed, no heading', () => {
    expect(attentionHeading({ errors: 0, warnings: 0, notices: 0 })).toBeNull()
  })

  test('a paused indexer alone is a notice in amber, not a red issue', () => {
    expect(attentionHeading({ errors: 0, warnings: 0, notices: 1 })).toEqual({ title: 'Worth knowing', badge: '1 notice', color: 'warning' })
    expect(attentionHeading({ errors: 0, warnings: 0, notices: 2 })?.badge).toBe('2 notices')
  })

  test('something to look at that isn\'t failing is amber', () => {
    expect(attentionHeading({ errors: 0, warnings: 1, notices: 1 })).toEqual({ title: 'Needs attention', badge: '2 issues', color: 'warning' })
  })

  test('anything broken makes it red', () => {
    expect(attentionHeading({ errors: 1, warnings: 0, notices: 0 })).toEqual({ title: 'Needs attention', badge: '1 issue', color: 'error' })
    expect(attentionHeading({ errors: 1, warnings: 2, notices: 1 })).toEqual({ title: 'Needs attention', badge: '4 issues', color: 'error' })
  })
})
