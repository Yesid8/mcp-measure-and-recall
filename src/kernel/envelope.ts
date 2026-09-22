import { ageSeconds, toIsoWithOffset, type AgeBasis, type Clock } from './clock.js'
import { IdPrefix, newId } from './ulid.js'
import { redact, redactText } from './redact.js'
import type { ToolError } from './result.js'

/** Non-fatal notices. Keeps `error` for what actually prevented observing. */
export interface Warning {
  readonly code: string
  readonly message: string
  readonly detail?: Readonly<Record<string, unknown>>
}

/** Every warning code the server can emit. Stable: callers may branch on them. */
export const WarningCodes = {
  BODY_TRUNCATED: 'BODY_TRUNCATED',
  BODY_CONTENT_TYPE_MISMATCH: 'BODY_CONTENT_TYPE_MISMATCH',
  LOG_LINE_UNREADABLE: 'LOG_LINE_UNREADABLE',
  LOG_SEQ_GAP: 'LOG_SEQ_GAP',
  MESSAGES_TRUNCATED: 'MESSAGES_TRUNCATED',
  WS_PROTOCOL_ERROR: 'WS_PROTOCOL_ERROR',
  WS_MESSAGE_INCOMPLETE: 'WS_MESSAGE_INCOMPLETE',
  CREDENTIALS_DROPPED_ON_REDIRECT: 'CREDENTIALS_DROPPED_ON_REDIRECT',
  REDIRECT_NOT_FOLLOWED: 'REDIRECT_NOT_FOLLOWED',
  OBSERVATION_NOT_RECORDED: 'OBSERVATION_NOT_RECORDED',
  PARTIAL_TAIL_TRUNCATED: 'PARTIAL_TAIL_TRUNCATED',
} as const

/**
 * Every tool returns this shape. The core builds it; a handler only supplies
 * `data`.
 */
export interface Envelope<T> {
  readonly observation_id: string
  readonly request_id: string
  readonly tool: string
  readonly project: string
  /** The EFFECTIVE arguments: after defaults, normalization and redaction. */
  readonly target: Readonly<Record<string, unknown>>

  readonly observed_at: string
  readonly age_seconds: number
  readonly age_basis: AgeBasis
  readonly duration_ms: number

  /**
   * "The observation could be taken." NOT a judgement about what was observed.
   * A cleanly received HTTP 500 is ok: true with data.http_status === 500.
   */
  readonly ok: boolean
  readonly error: { code: string; message: string; detail?: unknown } | null

  readonly data: T | null
  readonly warnings: readonly Warning[]
}

/** What the protocol layer knows about a call when it wraps the result. */
export interface EnvelopeInit<T> {
  readonly tool: string
  readonly project: string
  readonly target: Readonly<Record<string, unknown>>
  readonly requestId: string
  /** Monotonic instant captured when the observation started. */
  readonly startedMonotonic: number
  /** Wall clock captured when the observation started. */
  readonly startedAt: Date
  readonly clock: Clock
  readonly data: T | null
  readonly error?: ToolError | null
  readonly warnings?: readonly Warning[]
}

/**
 * Builds the envelope.
 *
 * `ok` is derived, never passed in: it is exactly `error === null`. Letting a
 * handler set it independently is how "ok" quietly starts meaning "the service
 * is fine", which is the one thing it must never mean.
 */
export function buildEnvelope<T>(init: EnvelopeInit<T>): Envelope<T> {
  const elapsedMs = init.clock.monotonic() - init.startedMonotonic
  const err = init.error ?? null
  return {
    observation_id: newId(IdPrefix.observation),
    request_id: init.requestId,
    tool: init.tool,
    project: init.project,
    target: redact(init.target) as Readonly<Record<string, unknown>>,
    observed_at: toIsoWithOffset(init.startedAt),
    age_seconds: ageSeconds(elapsedMs),
    age_basis: 'monotonic',
    duration_ms: Math.max(0, elapsedMs),
    ok: err === null,
    // Every field that can carry caller- or peer-supplied text is redacted here:
    // this is the single point where the envelope becomes safe to hand out and to
    // store. `data` because a response brings credentials the caller never sent
    // (set-cookie); `error` because messages echo input, and an unparseable URL
    // can still hold `user:password@`.
    error:
      err === null
        ? null
        : {
            code: err.code,
            message: redactText(err.message),
            // `cause` deliberately omitted: it goes to the log, never the client.
            ...(err.detail !== undefined ? { detail: redact(err.detail) } : {}),
          },
    data: redact(init.data) as T | null,
    warnings: redact(init.warnings ?? []) as readonly Warning[],
  }
}

/**
 * Age for a record read from disk, where the write's monotonic instant is gone.
 * Marked 'wall' so the weaker basis is visible rather than assumed.
 */
export function wallAge(
  observedAtIso: string,
  now: Date,
): { age_seconds: number; age_basis: AgeBasis } {
  const then = Date.parse(observedAtIso)
  if (Number.isNaN(then)) return { age_seconds: 0, age_basis: 'wall' }
  return { age_seconds: ageSeconds(now.getTime() - then), age_basis: 'wall' }
}
