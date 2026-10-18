import { describe, expect, test } from 'bun:test'
import { DOCS_ANCHORS, docsUrl } from './docs'

const GUIDE = new URL('../../../../website/guide/', import.meta.url)
const HEADING = /^#{1,6} (.+)$/
const PUNCTUATION = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu

// GitHub's heading ids: lowercase, punctuation dropped (backticks and emphasis
// marks included), each space a hyphen. Headings inside code fences don't count.
async function headingSlugs(page: string): Promise<string[]> {
  const text = await Bun.file(new URL(`${page}.md`, GUIDE)).text()
  const slugs: string[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    const heading = !fenced && HEADING.exec(line)?.[1]
    if (heading)
      slugs.push(heading.trim().toLowerCase().replace(PUNCTUATION, '').replaceAll(' ', '-'))
  }
  return slugs
}

describe('DOCS_ANCHORS', () => {
  for (const [page, anchors] of Object.entries(DOCS_ANCHORS)) {
    test(`${page}.md has every listed heading`, async () => {
      const slugs = await headingSlugs(page)
      expect(slugs.length).toBeGreaterThan(0)
      for (const anchor of anchors)
        expect(slugs).toContain(anchor)
    })
  }
})

describe('docsUrl', () => {
  test('links a page, with or without an anchor', () => {
    expect(docsUrl('unraid')).toBe('https://github.com/LeetDonkey/jack/blob/main/website/guide/unraid.md')
    expect(docsUrl('unraid', 'troubleshooting')).toBe('https://github.com/LeetDonkey/jack/blob/main/website/guide/unraid.md#troubleshooting')
  })
})
