/**
 * Links into the fork's guide on GitHub. The VitePress site still describes
 * upstream, so the guide is linked where it is maintained. Anchors are GitHub's
 * heading slugs; docs.test.ts fails when one no longer matches a heading in
 * website/guide/.
 */
const DOCS_BASE = 'https://github.com/LeetDonkey/jack/blob/main/website/guide/'

export const DOCS_ANCHORS = {
  'unraid': [
    '1-create-the-jack-network',
    '3-install-jack',
    '4-install-jack-ui',
    '5-connect-radarr-and-sonarr',
    '6-open-jack-to-your-friends',
    '7-connect-to-a-friend',
    'troubleshooting',
  ],
  'quick-links': [],
  'management-ui': [],
} as const

export type DocsPage = keyof typeof DOCS_ANCHORS

export function docsUrl<P extends DocsPage>(page: P, anchor?: (typeof DOCS_ANCHORS)[P][number]): string {
  return `${DOCS_BASE}${page}.md${anchor ? `#${anchor}` : ''}`
}
