// In cookie mode jack-ui keeps the key from the login form in a cookie sealed
// with the session key (JACK_SESSION_KEY). h3 seals it with iron-webcrypto,
// which throws on a key shorter than 32 characters, and seals a new session the
// first time a request opens it. With such a key, every request that opens the
// session fails. Unraid passes an empty template field as '', which replaces
// the default in nuxt.config.ts. Free of h3 and runtimeConfig, so the tests call
// it directly.

/** The shortest key iron-webcrypto seals with. */
export const MIN_SESSION_KEY_LENGTH = 32

/** Shown on the connection screen; uses the field names in the Unraid templates. */
export const MISSING_KEY_MESSAGE = 'Management key is empty in the jack-ui template, and Session key is empty or shorter than 32 characters. Fill in Management key with the same value as in the jack template, or, to be asked for the key in the browser, set Session key (under Show more settings) to at least 32 characters. Then click Apply.'

/** Whether `sessionKey` can seal the session cookie. */
export function canSealSession(sessionKey: unknown): sessionKey is string {
  return typeof sessionKey === 'string' && sessionKey.length >= MIN_SESSION_KEY_LENGTH
}

/**
 * Why jack-ui can't let anyone in, or null when it can. With a Management key
 * jack-ui never needs the cookie. Without one it needs a session key to seal it.
 */
export function missingKeyMessage(config: { managementKey?: unknown, sessionKey?: unknown }): string | null {
  if (config.managementKey || canSealSession(config.sessionKey))
    return null
  return MISSING_KEY_MESSAGE
}
