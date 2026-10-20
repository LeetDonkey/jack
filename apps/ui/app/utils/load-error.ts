import type { ManagementErrorInfo } from '~/composables/useManagement'

/**
 * Whether a failed call means jack (or jack-ui) didn't answer at all, rather than
 * jack answering with an error: nothing answered, or a 502/503/504 that carries
 * none of jack's error codes. The BFF answers 503 that way when jack is stopped
 * or restarting, and a reverse proxy in front of jack-ui answers 502 or 504.
 */
export function isJackUnreachable(info: Pick<ManagementErrorInfo, 'status' | 'code'>): boolean {
  if (info.status === undefined)
    return true
  return (info.status === 502 || info.status === 503 || info.status === 504) && info.code === null
}

export interface LoadErrorText {
  title: string
  description: string
}

const RETRYING = 'Trying again every few seconds.'
const CHECK_DOCKER = 'If it stays like this, check that the jack container is running (Docker tab).'

const SENTENCE_END = /[.!?]$/

function sentence(text: string): string {
  return SENTENCE_END.test(text) ? text : `${text}.`
}

/**
 * The words for a load that failed with nothing to show instead. `what` names
 * what a section failed to load ("the bandwidth settings"); without it the text
 * speaks for the whole page. When jack didn't answer, the BFF's own message would
 * say the same thing again, so it is left out.
 */
export function loadErrorText(info: Pick<ManagementErrorInfo, 'status' | 'code' | 'message'>, what?: string): LoadErrorText {
  if (isJackUnreachable(info)) {
    return {
      title: what ? `Can't load ${what}: jack isn't answering. It may be restarting.` : 'Can\'t reach jack. It may be restarting.',
      description: `${RETRYING} ${CHECK_DOCKER}`,
    }
  }
  return {
    title: what ? `Failed to load ${what}.` : 'Failed to load this page.',
    description: info.message ? `${sentence(info.message)} ${RETRYING}` : RETRYING,
  }
}
