/** jack's built-in internal URL. It only resolves on the jack Docker network. */
export const DEFAULT_INTERNAL_URL = 'http://jack:5225'

const TRAILING_SLASHES = /\/+$/

/** Whether a saved internal URL is still the default, ignoring trailing slashes. */
export function isDefaultInternalUrl(url: string): boolean {
  return url.trim().replace(TRAILING_SLASHES, '') === DEFAULT_INTERNAL_URL
}
