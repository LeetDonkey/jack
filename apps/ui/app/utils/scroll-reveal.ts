// A row that scrolls sideways (the Settings tabs on a phone): keep the selected
// item in view, and fade an edge out while there is more to scroll to behind it.

/** Horizontal positions of an element on screen, e.g. from getBoundingClientRect(). */
export interface HorizontalBox {
  left: number
  right: number
}

/**
 * The scrollLeft that shows `item` inside the row `view`, `margin` px clear of
 * either edge (where a fade sits). It is the smallest such position, whatever the
 * row's current `scrollLeft`, so the same item always lands in the same place and
 * a resize can't leave the row scrolled further than needed. Null when the row is
 * there already, or is too narrow to show the item at all (mid-layout).
 */
export function revealScrollLeft(view: HorizontalBox, scrollLeft: number, item: HorizontalBox, margin = 0): number | null {
  const width = view.right - view.left
  if (width < item.right - item.left + 2 * margin)
    return null
  // The item's place in the row's content, independent of the current scroll.
  const start = item.left - view.left + scrollLeft
  const end = item.right - view.left + scrollLeft
  const target = Math.min(Math.max(0, end - (width - margin)), Math.max(0, start - margin))
  return target === scrollLeft ? null : target
}

/** Which edges have more content behind them. One pixel of slack absorbs fractional scroll positions. */
export function scrollEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): { start: boolean, end: boolean } {
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < scrollWidth - 1,
  }
}

/** A mask-image that fades out each edge with more content behind it, or undefined when neither has. */
export function edgeFadeMask(edges: { start: boolean, end: boolean }, size = '1.5rem'): string | undefined {
  if (!edges.start && !edges.end)
    return undefined
  const from = edges.start ? `transparent, #000 ${size}` : '#000'
  const to = edges.end ? `#000 calc(100% - ${size}), transparent` : '#000'
  return `linear-gradient(to right, ${from}, ${to})`
}
