import type { DestinationRegistration } from '~/types/management'
import { arrMedia, indexerPause, registrationHeadline } from './server-role'

export interface EmptyFeedNote {
  // The note under the result.
  title: string
  description: string
  // In place of "<arr> tested jack's indexer and download client, and both work."
  headline: string
  // The indexer's row, in place of "Added. <arr>'s test passed."
  indexerDetail: string
}

/**
 * The words for a passed registration while jack has no friends, so its indexer
 * has nothing to list. jack counts the *arr's "no results" as a pass, but the Test
 * button on jack's indexer in the *arr shows it as a failure, and pressing it can
 * make the *arr skip the indexer. The result then says the *arr reached jack
 * rather than that the indexer works, and why its Test fails for now.
 *
 * Null with friends, or while their number is unknown: their releases of the
 * last `torznab.rssMaxAgeDays` fill the feed, and the page can't tell whether
 * there are any without loading every friend's library. Null too when the indexer
 * or its test didn't pass, or the *arr skips the indexer, since the result says
 * that instead.
 */
export function emptyFeedNote(registration: DestinationRegistration, server: { name: string, type: string }, friends: number | null, now: number): EmptyFeedNote | null {
  if (friends !== 0 || registration.indexer.status !== 'ok' || registration.indexerTest !== 'ok' || indexerPause(registration, now))
    return null
  const { name } = server
  const media = arrMedia(server.type)
  return {
    title: `The Test button on jack's indexer in ${name} fails for now`,
    description: `You have no friends in jack yet, so jack's indexer has no ${media} to list, and ${name} reports "no results". That's normal. Pressing Test can make ${name} skip jack's indexer for a while, so leave it until a friend shares ${media}.`,
    headline: `${name} reached jack's indexer and download client.`,
    indexerDetail: `Added. ${name} reached it.`,
  }
}

/**
 * registrationHeadline for the result after a save and the toast after Register
 * again, which say the *arr reached jack, not that both work, while jack has no
 * friends (see emptyFeedNote).
 */
export function registrationResultHeadline(registration: DestinationRegistration, server: { name: string, type: string }, friends: number | null, now = Date.now()): ReturnType<typeof registrationHeadline> {
  const headline = registrationHeadline(registration, server, now)
  const note = emptyFeedNote(registration, server, friends, now)
  return headline.tone === 'ok' && headline.description && note ? { ...headline, description: note.headline } : headline
}
