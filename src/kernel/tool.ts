import type { z } from 'zod'
import type { Clock } from './clock.js'
import type { Result } from './result.js'
import type { Warning } from './envelope.js'

/** Hints for the client. Not guarantees — the spec requires clients to treat them as untrusted. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/**
 * Everything a handler needs from the core arrives through here. Time comes
 * from `clock` rather than Date, so a test can move it; cancellation from
 * `signal` rather than a timer of the handler's own, so the core decides when
 * a call is over.
 */
export interface ToolContext {
  /** Aborted when the client cancels or the call's deadline passes. */
  readonly signal: AbortSignal
  readonly clock: Clock
  /**
   * The caller's `project`, already normalized. Empty when the server is built
   * with `requireProject: false`.
   */
  readonly project: string
  /** Non-fatal notices, surfaced in the envelope's `warnings`. */
  warn(w: Warning): void
}

/** A tool as the core registers it: schemas, prompt text and the handler. */
export interface ToolDefinition<I, O> {
  /** Without prefix. The core publishes it as `<toolPrefix>.<name>`. */
  readonly name: string
  readonly title: string
  /**
   * What it does, imperative, in English. This is prompt: the model decides
   * with it. It must say what it does NOT do.
   */
  readonly description: string

  readonly input: z.ZodType<I>
  readonly output: z.ZodType<O>

  readonly annotations?: ToolAnnotations
  /**
   * Deadline for one call, after which the core aborts `signal` and reports
   * TIMEOUT. It must exceed any timeout the tool accepts as input, so that the
   * tool's own, more specific timeout fires first.
   */
  readonly timeoutMs?: number
  /**
   * Whether each result is an observation of the world, handed to the server's
   * `recordObservation` so it can be cited later. Results the server refused
   * before observing anything are never recorded. Ignored when the server has
   * no `recordObservation`.
   */
  readonly records?: boolean

  /**
   * Builds the effective target: the arguments as they were actually used,
   * after defaults. Redaction is applied by the envelope builder.
   */
  readonly target: (input: I) => Readonly<Record<string, unknown>>

  readonly handler: (input: I, ctx: ToolContext) => Promise<Result<O>>
}

/**
 * A tool of any input and output, as a server's tool list holds them. `any` is
 * the honest type here: I appears both where it is produced (the schema) and
 * consumed (the handler), so no single concrete type admits every tool, and a
 * list typed any narrower makes every caller cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any, any>

/** Exists so typing infers I and O from the schemas without annotating them by hand. */
export function defineTool<I, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return Object.freeze(def)
}
