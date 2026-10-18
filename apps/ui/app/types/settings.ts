// A 400 from a management route whose body failed validation. `field` is the path
// of the first failing field, e.g. "url"; `issues` lists every failure with its
// message not prefixed by the field.
export interface ValidationErrorBody {
  ok: false
  error: {
    code: 'VALIDATION_ERROR'
    message: string
    field: string | null
    issues?: Array<{ field: string | null, message: string }>
  }
}
