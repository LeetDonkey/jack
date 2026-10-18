import z from 'zod'
import { FetchError } from '../../errors/FetchError'

/** One entry of the validation result *arr answers a failed save or test with. */
export interface ArrValidationFailure {
  message: string
  /** *arr's longer explanation, e.g. the underlying network error. */
  detail?: string
  /** A warning only: *arr would save the item anyway. */
  warning: boolean
}

// *arr (Servarr) serialises FluentValidation failures. `severity` comes as a string
// or as the enum number (0 error, 1 warning, 2 info) depending on the version.
const ValidationFailures = z.array(z.looseObject({
  propertyName: z.string().nullish(),
  errorMessage: z.string().nullish(),
  detailedDescription: z.string().nullish(),
  isWarning: z.boolean().nullish(),
  severity: z.union([z.string(), z.number()]).nullish(),
}))

const ErrorMessageBody = z.looseObject({ message: z.string() })

function isWarning(failure: z.infer<typeof ValidationFailures>[number]): boolean {
  if (failure.isWarning === true)
    return true
  const severity = failure.severity
  return severity === 1 || (typeof severity === 'string' && severity.toLowerCase() === 'warning')
}

function parseJson(body: string | undefined): unknown {
  if (!body)
    return undefined
  try {
    return JSON.parse(body)
  }
  catch {
    return undefined
  }
}

/** The validation failures in a 400 body from *arr, or [] when the body is something else. */
export function parseArrValidationFailures(body: string | undefined): ArrValidationFailure[] {
  const parsed = ValidationFailures.safeParse(parseJson(body))
  if (!parsed.success)
    return []
  return parsed.data
    .filter(failure => failure.errorMessage)
    .map(failure => ({
      message: failure.errorMessage!,
      ...(failure.detailedDescription ? { detail: failure.detailedDescription } : {}),
      warning: isWarning(failure),
    }))
}

/** A failure as one line: the message, then *arr's detail in parentheses when it adds something. */
export function formatArrValidationFailure(failure: ArrValidationFailure): string {
  return failure.detail && !failure.message.includes(failure.detail)
    ? `${failure.message} (${failure.detail})`
    : failure.message
}

/**
 * One readable line for an error from a call to *arr: its validation messages, its
 * `message` field, the HTTP status, or the network error.
 */
export function describeArrError(err: unknown): string {
  if (err instanceof FetchError) {
    const status = err.response.status
    const failures = parseArrValidationFailures(err.extras.body)
    if (failures.length > 0)
      return failures.map(formatArrValidationFailure).join('; ')
    const body = ErrorMessageBody.safeParse(parseJson(err.extras.body))
    if (body.success)
      return `${body.data.message} (HTTP ${status})`
    return `HTTP ${status} ${err.response.statusText}`.trim()
  }
  if (err instanceof DOMException && err.name === 'TimeoutError')
    return 'The request timed out'
  return err instanceof Error ? err.message : String(err)
}
