/**
 * Expected failures are values, not exceptions (docs/v2/00-contrato.md, N2).
 *
 * A handler returns Ok or Err. Throwing means a bug: the protocol layer turns
 * it into a JSON-RPC -32603 with the trace in the log and no detail to the
 * client. An Err, by contrast, reaches the client as a tool error it can read
 * and correct itself from.
 */

export type Result<T, E = ToolError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E extends ToolError>(error: E): Result<never, E> => ({ ok: false, error })

export interface ToolError {
  /** SCREAMING_SNAKE_CASE, stable, part of the public contract. */
  readonly code: string
  /** What failed, mechanically. Never what it means nor what to do about it. */
  readonly message: string
  /** Structured failure data. Serialized to the client after redaction. */
  readonly detail?: Readonly<Record<string, unknown>>
  /** Original cause. Goes to the log, never to the client. */
  readonly cause?: unknown
}

export function toolError(
  code: string,
  message: string,
  opts?: { detail?: Readonly<Record<string, unknown>>; cause?: unknown },
): ToolError {
  return {
    code,
    message,
    ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
    ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
  }
}

/** Error codes shared by every tool. Tool-specific codes are declared where raised. */
export const CoreErrors = {
  INVALID_PROJECT: 'INVALID_PROJECT',
  INVALID_INPUT: 'INVALID_INPUT',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  STORAGE_ERROR: 'STORAGE_ERROR',
} as const
