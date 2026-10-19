import { describe, expect, test } from 'bun:test'
import { edgeFadeMask, revealScrollLeft, scrollEdges } from './scroll-reveal'

// The Settings tab bar on a 400 px phone: the bar spans 12-388 on screen and its
// tabs 500 px. At scrollLeft 0: Radarr & Sonarr 12-142, Sharing 142-216,
// Bandwidth 216-311, Notifications 311-422, Advanced 422-512.
const view = { left: 12, right: 388 }

describe('revealScrollLeft', () => {
  test('leaves an item that is in view', () => {
    expect(revealScrollLeft(view, 0, { left: 12, right: 142 }, 24)).toBeNull()
    expect(revealScrollLeft(view, 0, { left: 142, right: 216 }, 24)).toBeNull()
  })

  test('scrolls to an item past the end, clear of the fade', () => {
    // Notifications: 422 - 12 - (376 - 24) = 58.
    expect(revealScrollLeft(view, 0, { left: 311, right: 422 }, 24)).toBe(58)
    // Advanced asks for 148; the browser stops at the end of the row (124).
    expect(revealScrollLeft(view, 0, { left: 422, right: 512 }, 24)).toBe(148)
  })

  test('lands on the same place from any scroll position', () => {
    // Notifications with the row scrolled to its end (124): back to 58.
    expect(revealScrollLeft(view, 124, { left: 311 - 124, right: 422 - 124 }, 24)).toBe(58)
    // Sharing with the row scrolled to 106: back to the start.
    expect(revealScrollLeft(view, 106, { left: 142 - 106, right: 216 - 106 }, 24)).toBe(0)
    // Advanced at the end already.
    expect(revealScrollLeft(view, 148, { left: 422 - 148, right: 512 - 148 }, 24)).toBeNull()
  })

  test('does nothing while the row is too narrow to show the item', () => {
    // Mid-layout, the row was measured 8 px wide.
    expect(revealScrollLeft({ left: 12, right: 20 }, 0, { left: 142, right: 216 }, 24)).toBeNull()
  })
})

describe('scrollEdges', () => {
  test('reports the edges with more content behind them', () => {
    expect(scrollEdges(0, 376, 500)).toEqual({ start: false, end: true })
    expect(scrollEdges(58, 376, 500)).toEqual({ start: true, end: true })
    expect(scrollEdges(124, 376, 500)).toEqual({ start: true, end: false })
    expect(scrollEdges(123.5, 376, 500)).toEqual({ start: true, end: false })
    expect(scrollEdges(0, 500, 500)).toEqual({ start: false, end: false })
  })
})

describe('edgeFadeMask', () => {
  test('fades only the edges that can scroll', () => {
    expect(edgeFadeMask({ start: false, end: false })).toBeUndefined()
    expect(edgeFadeMask({ start: false, end: true })).toBe('linear-gradient(to right, #000, #000 calc(100% - 1.5rem), transparent)')
    expect(edgeFadeMask({ start: true, end: false })).toBe('linear-gradient(to right, transparent, #000 1.5rem, #000)')
    expect(edgeFadeMask({ start: true, end: true }, '2rem')).toBe('linear-gradient(to right, transparent, #000 2rem, #000 calc(100% - 2rem), transparent)')
  })
})
