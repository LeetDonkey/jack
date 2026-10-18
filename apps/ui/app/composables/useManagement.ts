import type { NitroFetchOptions } from 'nitropack'
import type { ManagementErrorBody, PeerErrorCode, ValidationIssue } from '~/types/management'

/** What a failed management call said, read from the error ofetch threw. */
export interface ManagementErrorInfo {
  // HTTP status of the answer; undefined when nothing answered.
  status: number | undefined
  // The backend's error code (`VALIDATION_ERROR`, `CONNECTOR_INITIALIZATION_FAILED`, …).
  code: string | null
  // The message to show, or null when the answer carried none.
  message: string | null
  // On a validation failure: the dotted path of the first offending field.
  field: string | null
  issues: ValidationIssue[]
  // On a peer that failed its handshake: why, and what its jack or proxy answered.
  reason: PeerErrorCode | null
  upstreamStatus: number | null
}

interface FetchErrorLike {
  data?: unknown
  status?: number
  statusCode?: number
  response?: { status?: number }
  request?: unknown
  message?: string
  name?: string
}

// ofetch's own message ("[POST] "/api/management/x": 502 Bad Gateway") names the
// proxy path, which tells a user nothing.
const OFETCH_MESSAGE = /^\[[A-Z]+\] "/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Reads every error shape the BFF and jack answer with. Never throws. */
export function managementErrorInfo(error: unknown): ManagementErrorInfo {
  const err = (isRecord(error) ? error : {}) as FetchErrorLike
  const status = err.response?.status ?? err.statusCode ?? err.status
  const info: ManagementErrorInfo = { status, code: null, message: null, field: null, issues: [], reason: null, upstreamStatus: null }
  const data = err.data

  if (isRecord(data)) {
    const body = data.error
    if (isRecord(body) && !Array.isArray(body)) {
      // jack: { ok: false, error: { code, message, field?, issues?, reason?, upstreamStatus? } }
      const e = body as ManagementErrorBody
      info.code = text(e.code)
      info.message = text(e.message)
      info.field = text(e.field)
      info.issues = Array.isArray(e.issues) ? e.issues.filter(i => isRecord(i) && text(i.message)) : []
      info.reason = text(e.reason) as PeerErrorCode | null
      info.upstreamStatus = typeof e.upstreamStatus === 'number' ? e.upstreamStatus : null
    }
    else if (Array.isArray(body)) {
      // A validator's own format: { error: [{ message, path }] }.
      info.message = text((body[0] as { message?: unknown } | undefined)?.message)
    }
    else {
      // A plain { error: '…' } body.
      info.message = text(body)
    }
    // The BFF's own errors (h3): { statusCode, statusMessage, message }.
    info.message ??= text(data.message) ?? text(data.statusMessage)
  }

  // An error our own code threw (not a fetch) carries a message meant for the user.
  const isFetch = err.name === 'FetchError' || 'request' in err || 'response' in err
  if (!info.message && !isFetch && !OFETCH_MESSAGE.test(err.message ?? ''))
    info.message = text(err.message)

  return info
}

/**
 * Thin wrapper over the BFF proxy. Every data call routes through
 * `/api/management/*`; a 401 flips the global auth state back to the login gate.
 */
export function useManagement() {
  const auth = useAuthState()

  async function request<T>(path: string, opts: NitroFetchOptions<string> = {}): Promise<T> {
    try {
      return await $fetch<T>(`/api/management/${path}`, opts) as T
    }
    catch (error) {
      const status = (error as { response?: { status?: number }, statusCode?: number })?.response?.status
        ?? (error as { statusCode?: number })?.statusCode
      if (status === 401) {
        // In env-inject mode a 401 means the injected key was rejected — prompting
        // for a key the operator can't change from the browser is useless, so show
        // the same screen as a rejected key at sign-in. In cookie mode it means the
        // session lapsed → login gate.
        auth.value = auth.value.mode === 'env'
          ? { ...auth.value, status: 'error', reason: 'unauthorized', message: 'The Management key in the jack-ui template doesn\'t match the one in the jack template.' }
          : { ...auth.value, status: 'needs-key' }
      }
      throw error
    }
  }

  /**
   * The message to show for a failed call: jack's own message (a validation
   * failure's starts with the field: "url: Invalid URL"), else `fallback`. Never
   * ofetch's "[POST] "/api/…"" text.
   */
  function extractError(error: unknown, fallback = 'Request failed'): string {
    return managementErrorInfo(error).message ?? fallback
  }

  /**
   * A validation failure that names a field, as `{ name, message }` for
   * `form.setErrors([…])`, so the message shows on the field. The message is the
   * issue's own text, without the field prefix. Null for any other failure.
   */
  function extractFieldError(error: unknown): { name: string, message: string } | null {
    const info = managementErrorInfo(error)
    if (!info.field)
      return null
    const issue = info.issues.find(i => i.field === info.field) ?? info.issues[0]
    const message = issue?.message ?? info.message
    return message ? { name: info.field, message } : null
  }

  return { request, extractError, extractFieldError, errorInfo: managementErrorInfo }
}
