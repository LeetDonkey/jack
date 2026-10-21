import { describe, expect, test } from 'bun:test'

// jack-ui bundles its icons (`icon` in nuxt.config.ts) and fetches none at run
// time: the scan there reads the same files as this test, and only Phosphor is
// installed. A name Phosphor doesn't have, or another collection, draws nothing.
const APP_DIR = new URL('./', import.meta.url).pathname
const ICON = /\bi-([a-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g

interface IconSet { icons: Record<string, unknown>, aliases?: Record<string, unknown> }

async function usedIcons(): Promise<Map<string, string[]>> {
  const used = new Map<string, string[]>()
  for await (const file of new Bun.Glob('**/*.{vue,ts}').scan(APP_DIR)) {
    if (file.endsWith('.test.ts'))
      continue
    const text = await Bun.file(APP_DIR + file).text()
    for (const [, prefix, name] of text.matchAll(ICON)) {
      const icon = `${prefix}:${name}`
      used.set(icon, [...(used.get(icon) ?? []), file])
    }
  }
  return used
}

describe('icons', () => {
  test('every icon the app names is in the bundled Phosphor set', async () => {
    const ph = await Bun.file(Bun.resolveSync('@iconify-json/ph/icons.json', APP_DIR)).json() as IconSet
    const used = await usedIcons()
    expect(used.size).toBeGreaterThan(50)
    const missing = [...used].filter(([icon]) => {
      const [prefix, name = ''] = icon.split(':')
      return prefix !== 'ph' || !(name in ph.icons || name in (ph.aliases ?? {}))
    }).map(([icon, files]) => `${icon} (${[...new Set(files)].join(', ')})`)
    expect(missing).toEqual([])
  })
})
