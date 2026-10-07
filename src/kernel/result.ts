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

/**
 * Every error code the package can emit, in one place. Stable: callers branch
 * on them, so a code is never renamed or reused for another meaning. Raising
 * one that is not listed here is caught by a conformance test.
 */
export const ErrorCodes = {
  // The call itself, whatever the tool.
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_PROJECT: 'INVALID_PROJECT',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',

  // Refused by policy before any I/O.
  URL_INVALID: 'URL_INVALID',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',

  // Failures to observe: the network did not let the measurement complete.
  DNS_FAILURE: 'DNS_FAILURE',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  CONNECTION_RESET: 'CONNECTION_RESET',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  HOST_UNREACHABLE: 'HOST_UNREACHABLE',
  TLS_ERROR: 'TLS_ERROR',
  BODY_READ_FAILED: 'BODY_READ_FAILED',
  DECOMPRESSION_LIMIT: 'DECOMPRESSION_LIMIT',
  WS_HANDSHAKE_FAILED: 'WS_HANDSHAKE_FAILED',

  // The registry.
  OBSERVATION_NOT_FOUND: 'OBSERVATION_NOT_FOUND',
  OBSERVED_AT_REQUIRED: 'OBSERVED_AT_REQUIRED',
  OBSERVED_AT_NOT_ALLOWED: 'OBSERVED_AT_NOT_ALLOWED',
  CLAIM_NOT_FOUND: 'CLAIM_NOT_FOUND',
  ALREADY_RETRACTED: 'ALREADY_RETRACTED',
  CIRCULAR_SUPERSEDE: 'CIRCULAR_SUPERSEDE',
  STORAGE_ERROR: 'STORAGE_ERROR',

  // Startup: these stop the server instead of reaching a client.
  CONFIG_INVALID: 'CONFIG_INVALID',
  DATA_DIR_IN_USE: 'DATA_DIR_IN_USE',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/** The subset any tool may raise. Kept for compatibility; ErrorCodes is the full list. */
export const CoreErrors = {
  INVALID_PROJECT: ErrorCodes.INVALID_PROJECT,
  INVALID_INPUT: ErrorCodes.INVALID_INPUT,
  HOST_NOT_ALLOWED: ErrorCodes.HOST_NOT_ALLOWED,
  PATH_NOT_ALLOWED: ErrorCodes.PATH_NOT_ALLOWED,
  TIMEOUT: ErrorCodes.TIMEOUT,
  CANCELLED: ErrorCodes.CANCELLED,
  STORAGE_ERROR: ErrorCodes.STORAGE_ERROR,
} as const
