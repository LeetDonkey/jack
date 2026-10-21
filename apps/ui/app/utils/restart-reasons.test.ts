import { describe, expect, test } from 'bun:test'
import { restartReasonLabels } from './restart-reasons'

describe('restartReasonLabels', () => {
  test('names each reason as Settings names it, in jack\'s order', () => {
    expect(restartReasonLabels(['downloads.completedPath', 'downloads.retries', 'downloads.import']))
      .toEqual(['Completed folder', 'Download retries', 'Handing files to Radarr/Sonarr'])
  })

  test('a retry change alone names only Download retries', () => {
    expect(restartReasonLabels(['downloads.retries'])).toEqual(['Download retries'])
  })

  test('a reason from a newer jack shows as jack names it', () => {
    expect(restartReasonLabels(['downloads', 'torznab.something'])).toEqual(['Downloads', 'torznab.something'])
  })
})
