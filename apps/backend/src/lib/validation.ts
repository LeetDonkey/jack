import type { Context } from 'hono'
import type { z } from 'zod'
import { validator as openApiValidator } from 'hono-openapi'
import { AppError } from './errors/AppError'

/** One problem with a request, keyed by the dotted path of the field it concerns. */
export interface ValidationIssue {
  /** Dotted path of the field (`url`, `schedule.0.days`), or null for the body as a whole. */
  field: string | null
  message: string
}

// The issue shape both zod and Standard Schema validators produce.
interface IssueLike {
  message: string
  path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
}

function fieldOf(path: IssueLike['path']): string | null {
  if (!path?.length)
    return null
  return path.map(segment => String(typeof segment === 'object' ? segment.key : segment)).join('.')
}

export function toValidationIssues(issues: readonly IssueLike[]): ValidationIssue[] {
  return issues.map(issue => ({ field: fieldOf(issue.path), message: issue.message }))
}

function messageOf(issue: ValidationIssue | undefined): string {
  if (!issue)
    return 'The request is invalid'
  return issue.field ? `${issue.field}: ${issue.message}` : issue.message
}

/**
 * A request the management API refuses because of its content. Serialized by
 * handle-error as `{ ok: false, error: { code, message, field, issues } }`, the
 * same body the route validators answer with, so a client reads one format:
 * `message` and `field` describe the first problem, `issues` lists all of them.
 */
export class ValidationError extends AppError {
  public readonly field: string | null
  public readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super(messageOf(issues[0]), 'VALIDATION_ERROR', { cause: undefined })
    this.field = issues[0]?.field ?? null
    this.issues = issues
  }

  static fromZod(error: z.ZodError): ValidationError {
    return new ValidationError(toValidationIssues(error.issues))
  }

  /** A single problem with one field. */
  static forField(field: string, message: string): ValidationError {
    return new ValidationError([{ field, message }])
  }
}

/** The 400 body for a request that failed validation. */
export function validationErrorBody(issues: ValidationIssue[]) {
  return {
    ok: false as const,
    error: { code: 'VALIDATION_ERROR', message: messageOf(issues[0]), field: issues[0]?.field ?? null, issues },
  }
}

/**
 * Validator hook for management routes: answers a failed validation with
 * `validationErrorBody` instead of the library's `{ success, error: [issues], data }`,
 * which also echoed the submitted body (secrets included) back to the client.
 */
export function validationHook(result: { success: boolean, error?: readonly IssueLike[] }, c: Context): Response | undefined {
  if (result.success)
    return undefined
  return c.json(validationErrorBody(toValidationIssues(result.error ?? [])), 400)
}

/**
 * hono-openapi's `validator` with `validationHook` as the default hook. The
 * returned middleware is the library's own, so the route still documents its
 * request schema in the OpenAPI spec.
 */
export const validator = ((target, schema, hook, options) =>
  openApiValidator(target, schema, hook ?? validationHook, options)) as typeof openApiValidator
