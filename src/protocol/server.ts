import { z } from 'zod'
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  MetaKeys,
  failure,
  success,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestId,
} from './jsonrpc.js'
import { buildEnvelope, WarningCodes, type Envelope, type Warning } from '../kernel/envelope.js'
import { toIsoWithOffset, type Clock } from '../kernel/clock.js'
import { IdPrefix, newId } from '../kernel/ulid.js'
import { normalizeProject } from '../kernel/project.js'
import { CoreErrors, toolError, type Result, type ToolError } from '../kernel/result.js'
import type { ToolContext, ToolDefinition } from '../kernel/tool.js'

export interface ServerInfo {
  readonly name: string
  readonly version: string
}

/** Fixed at construction: the tool set cannot change while the server runs. */
export interface ProtocolServerOptions {
  readonly info: ServerInfo
  readonly instructions: string
  readonly tools: readonly ToolDefinition<never, never>[]
  readonly clock: Clock
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: unknown) => void
  /** Deadline for tools that declare no `timeoutMs`. */
  readonly defaultTimeoutMs?: number
  /**
   * Persists an observation so it can be cited as evidence later.
   *
   * Only measure.* observations are recorded: a recall.* result is a reading of
   * the registry, and citing a reading as evidence of itself would let the
   * registry become its own source.
   */
  readonly recordObservation?: (envelope: Envelope<unknown>) => Promise<Result<void>>
}

interface ListedTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly outputSchema: Record<string, unknown>
  readonly annotations?: Record<string, unknown>
}

const MODULE_ID = 'facts'

/** How long a cacheable result stays fresh. Milliseconds, and `>= 0`. */
const DEFAULT_TTL_MS = 300_000

/** Deadline for a tool that declares none. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000

/**
 * How long a handler may keep running after its signal aborts before the call
 * is answered without it. A handler that ignores its signal is a bug, but the
 * bug must not become a request the client waits on forever.
 */
const ABORT_GRACE_MS = 1_000

/** The abort reason of a client's notifications/cancelled, told apart from a deadline. */
const CLIENT_CANCELLED = new Error('cancelled by client')

/**
 * Tool errors that mean nothing was observed: the call was refused before any
 * destination was contacted. Every other outcome of a measure.* call — a 500, a
 * refused connection, a DNS failure, a timeout — is an observation of the world
 * and is recorded, because "nothing answers on that port" is a citable fact.
 */
const NOT_AN_OBSERVATION: ReadonlySet<string> = new Set([
  CoreErrors.INVALID_INPUT,
  CoreErrors.INVALID_PROJECT,
  CoreErrors.HOST_NOT_ALLOWED,
  CoreErrors.PATH_NOT_ALLOWED,
  CoreErrors.CANCELLED,
  'URL_INVALID',
])

/**
 * The `CacheableResult` hints (SEP-2549).
 *
 * The spec requires these on every `resultType: "complete"` result returned by
 * server/discover, tools/list, prompts/list, resources/list,
 * resources/templates/list and resources/read — not just the lists. This lives
 * in one function so the next cacheable result cannot silently omit them.
 *
 * Four rules that are easy to break without noticing:
 *   1. `ttlMs` is an integer >= 0. `0` means "immediately stale", NOT "never expires".
 *   2. An `input_required` result carries no hints, and an MRTR retry is not
 *      cacheable: it depends on inputs that are not part of the cache key.
 *   3. Each page of a paginated listing carries its own `ttlMs`, but every page
 *      of one request must carry the same `cacheScope`.
 *   4. `"public"` may be shared ACROSS authorization contexts, even from an
 *      authenticated endpoint. It is not an access control — it is a statement
 *      that the content belongs to nobody in particular.
 *
 * Plinth serves `"private"` everywhere: the tool set can vary with the
 * authorization presented, so nothing here is safe to share across contexts.
 */
function cacheHints(ttlMs: number = DEFAULT_TTL_MS): {
  ttlMs: number
  cacheScope: 'private' | 'public'
} {
  return { ttlMs: Math.max(0, Math.trunc(ttlMs)), cacheScope: 'private' }
}

/**
 * The protocol layer: the only hard boundary in the package.
 *
 * Implements MCP 2026-07-28 directly against the normative schema. Why, and the
 * spike that may replace it with @modelcontextprotocol/server: docs/adr/0002.
 */
export class ProtocolServer {
  readonly #tools = new Map<string, ToolDefinition<never, never>>()
  readonly #listed: readonly ListedTool[]
  readonly #discover: Record<string, unknown>
  readonly #opts: ProtocolServerOptions
  readonly #inFlight = new Map<RequestId, AbortController>()
  /** Every tools/call not yet answered, so shutdown can wait for them. */
  readonly #pending = new Set<Promise<unknown>>()

  constructor(opts: ProtocolServerOptions) {
    this.#opts = opts

    for (const tool of opts.tools) {
      const full = `${MODULE_ID}.${tool.name}`
      if (this.#tools.has(full)) throw new Error(`duplicate tool name: ${full}`)
      this.#tools.set(full, tool)
    }

    // Deterministic order, computed once at startup: the spec asks for it so the
    // client can cache and so the model's prompt cache hits. tools/list never
    // serializes anything hot.
    this.#listed = [...this.#tools.entries()]
      .map(([full, t]) => this.#describe(full, t))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    // Built once; server/discover must answer without touching disk or network.
    this.#discover = {
      resultType: 'complete',
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      serverInfo: { name: opts.info.name, version: opts.info.version },
      // Only what is implemented: announcing resources would invite calls
      // that can only fail with -32601.
      capabilities: {
        tools: { listChanged: false },
        extensions: {},
      },
      instructions: opts.instructions,
      ...cacheHints(),
    }
  }

  #describe(full: string, tool: ToolDefinition<never, never>): ListedTool {
    const inputSchema = z.toJSONSchema(tool.input, { target: 'draft-2020-12' }) as Record<
      string,
      unknown
    >
    const dataSchema = z.toJSONSchema(tool.output, { target: 'draft-2020-12' }) as Record<
      string,
      unknown
    >
    return {
      name: full,
      title: tool.title,
      description: tool.description,
      inputSchema,
      // The published outputSchema describes the WHOLE envelope, not just data,
      // so the client can validate the entire response.
      outputSchema: envelopeSchema(dataSchema),
      ...(tool.annotations !== undefined
        ? { annotations: tool.annotations as Record<string, unknown> }
        : {}),
    }
  }

  /**
   * Cancels an in-flight request. stdio maps notifications/cancelled here.
   *
   * The request gets no response: the client has said it will not use one.
   */
  cancel(id: RequestId): void {
    this.#inFlight.get(id)?.abort(CLIENT_CANCELLED)
  }

  /** tools/call requests received and not yet answered, cancelled or abandoned. */
  get pendingCalls(): number {
    return this.#pending.size
  }

  /**
   * Aborts every call in flight and waits for them to be answered, for at most
   * `graceMs`. For shutdown: a call cut off mid-write would leave its client
   * waiting, and a wait with no bound would leave the process hanging.
   */
  async drain(graceMs: number): Promise<void> {
    for (const controller of this.#inFlight.values()) {
      controller.abort(new Error('server shutting down'))
    }
    if (this.#pending.size === 0) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled(this.#pending),
      new Promise((resolve) => (timer = setTimeout(resolve, graceMs))),
    ])
    clearTimeout(timer)
  }

  /**
   * Dispatches one decoded JSON-RPC message.
   *
   * The input is `unknown` on purpose: it is whatever JSON.parse produced. A
   * `null`, a number or a batch array must be answered with -32600 rather than
   * reach code that assumes an object — a thrown TypeError leaves the client
   * waiting for a response that never comes.
   */
  async handle(raw: unknown): Promise<JsonRpcResponse | null> {
    const shape = this.#classify(raw)
    if (shape.kind === 'invalid') return shape.response
    if (shape.kind === 'ignore') return null
    if (shape.kind === 'notification') {
      if (shape.msg.method === 'notifications/cancelled') {
        const target = shape.msg.params?.['requestId']
        if (typeof target === 'string' || typeof target === 'number') this.cancel(target)
      }
      return null
    }

    const req = shape.msg
    const id = req.id

    // A legacy client sends initialize. It has no way to move forward, and this
    // message is the only diagnostic its user will ever see.
    if (req.method === 'initialize') {
      return failure(
        id,
        UNSUPPORTED_PROTOCOL_VERSION,
        `this server implements MCP ${LATEST_PROTOCOL_VERSION}, which removed the initialize handshake; supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
        { supported: [...SUPPORTED_PROTOCOL_VERSIONS], ...this.#errorTime() },
      )
    }

    // server/discover is the compatibility probe: a client may call it before
    // anything else, so it is exempt from the _meta requirements.
    if (req.method === 'server/discover') return success(id, this.#discover)

    const metaCheck = this.#checkMeta(req)
    if (metaCheck !== null) return failure(id, metaCheck.code, metaCheck.message, metaCheck.data)

    switch (req.method) {
      case 'tools/list':
        return success(id, {
          resultType: 'complete',
          tools: this.#listed,
          ...cacheHints(),
        })
      case 'tools/call': {
        const call = this.#call(req)
        this.#pending.add(call)
        const done = (): void => void this.#pending.delete(call)
        call.then(done, done)
        return await call
      }
      default:
        return failure(
          id,
          METHOD_NOT_FOUND,
          `method not implemented: ${req.method}`,
          this.#errorTime(),
        )
    }
  }

  #classify(
    raw: unknown,
  ):
    | { kind: 'request'; msg: JsonRpcRequest }
    | { kind: 'notification'; msg: JsonRpcNotification }
    | { kind: 'ignore' }
    | { kind: 'invalid'; response: JsonRpcResponse } {
    const invalid = (id: RequestId | null, message: string) => ({
      kind: 'invalid' as const,
      response: failure(id, INVALID_REQUEST, message, this.#errorTime()),
    })

    if (Array.isArray(raw)) return invalid(null, 'batch requests are not supported')
    if (raw === null || typeof raw !== 'object') {
      return invalid(null, 'a JSON-RPC message must be an object')
    }
    const msg = raw as Record<string, unknown>
    const id = msg['id']
    const validId = typeof id === 'string' || typeof id === 'number' ? id : null

    // A response sent by the client: this server issues no requests, so there
    // is nothing to match it to, and JSON-RPC forbids answering a response.
    if (msg['method'] === undefined && ('result' in msg || 'error' in msg))
      return { kind: 'ignore' }

    const method = msg['method']
    if (typeof method !== 'string') return invalid(validId, 'the message has no string method')

    const params = msg['params']
    if (
      params !== undefined &&
      (params === null || typeof params !== 'object' || Array.isArray(params))
    ) {
      return invalid(validId, 'params must be an object when present')
    }
    const typedParams = params as Record<string, unknown> | undefined

    if (!('id' in msg)) {
      return {
        kind: 'notification',
        msg: { jsonrpc: JSONRPC_VERSION, method, ...(typedParams ? { params: typedParams } : {}) },
      }
    }
    // MCP requires a string or integer id; null is not a request id.
    if (validId === null) return invalid(null, 'a request id must be a string or a number')
    return {
      kind: 'request',
      msg: {
        jsonrpc: JSONRPC_VERSION,
        id: validId,
        method,
        ...(typedParams ? { params: typedParams } : {}),
      },
    }
  }

  #errorTime(): Record<string, unknown> {
    // N1 has no exceptions: error responses carry the time too.
    return { observed_at: toIsoWithOffset(this.#opts.clock.now()), age_seconds: 0 }
  }

  #checkMeta(req: JsonRpcRequest): { code: number; message: string; data: unknown } | null {
    const meta = (req.params?.['_meta'] ?? {}) as Record<string, unknown>

    const version = meta[MetaKeys.protocolVersion]
    if (typeof version !== 'string') {
      return {
        code: INVALID_PARAMS,
        message: `missing required _meta field: ${MetaKeys.protocolVersion}`,
        data: this.#errorTime(),
      }
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version as typeof LATEST_PROTOCOL_VERSION)) {
      return {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: `unsupported protocol version: ${version}`,
        data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], ...this.#errorTime() },
      }
    }

    const caps = meta[MetaKeys.clientCapabilities]
    if (caps === undefined || caps === null || typeof caps !== 'object') {
      return {
        code: MISSING_REQUIRED_CLIENT_CAPABILITY,
        message: `missing required _meta field: ${MetaKeys.clientCapabilities}`,
        data: { requiredCapabilities: ['tools'], ...this.#errorTime() },
      }
    }
    return null
  }

  async #call(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id
    const name = req.params?.['name']
    if (typeof name !== 'string') {
      return failure(
        id,
        INVALID_PARAMS,
        'tools/call requires a string params.name',
        this.#errorTime(),
      )
    }
    const tool = this.#tools.get(name)
    if (tool === undefined) {
      return failure(id, INVALID_PARAMS, `unknown tool: ${name}`, this.#errorTime())
    }

    const args: unknown = req.params?.['arguments'] ?? {}
    // CallToolRequest types arguments as an object; anything else breaks the
    // request itself, before any tool schema is involved.
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return failure(
        id,
        INVALID_PARAMS,
        'tools/call arguments must be an object',
        this.#errorTime(),
      )
    }
    const rawArgs = args as Record<string, unknown>
    const meta = (req.params?.['_meta'] ?? {}) as Record<string, unknown>
    // Self-declared and unverified: logged for diagnosis, never used to decide.
    const clientInfo = meta[MetaKeys.clientInfo]

    const startedAt = this.#opts.clock.now()
    const startedMonotonic = this.#opts.clock.monotonic()
    const requestId = newId(IdPrefix.request)

    // What every envelope from this call shares, whichever path it takes.
    const base = { tool: name, requestId, startedMonotonic, startedAt, clock: this.#opts.clock }
    const asToolError = (
      project: string,
      target: Readonly<Record<string, unknown>>,
      error: ToolError,
    ): JsonRpcResponse =>
      success(
        id,
        this.#toolResult(buildEnvelope({ ...base, project, target, data: null, error }), true),
      )

    // Invalid arguments are a TOOL error, not a JSON-RPC error: the model can
    // read the zod detail and correct itself on the next call.
    const parsed = tool.input.safeParse(args)
    if (!parsed.success) {
      return asToolError(
        typeof rawArgs['project'] === 'string' ? rawArgs['project'] : '',
        rawArgs,
        toolError(CoreErrors.INVALID_INPUT, 'arguments do not match the tool schema', {
          detail: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message,
            })),
          },
        }),
      )
    }

    const input = parsed.data as Record<string, unknown>
    const projectRaw = typeof input['project'] === 'string' ? input['project'] : ''
    const normalized = normalizeProject(projectRaw)
    if (!normalized.ok) {
      return asToolError(projectRaw, tool.target(parsed.data as never), normalized.error)
    }

    const timeoutMs = tool.timeoutMs ?? this.#opts.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const controller = new AbortController()
    this.#inFlight.set(id, controller)
    // Remembered so the outcome can say TIMEOUT rather than CANCELLED: the two
    // abort the same signal, but only one of them was the client's doing.
    let deadlineHit = false
    const timer = setTimeout(() => {
      deadlineHit = true
      controller.abort(new Error('deadline exceeded'))
    }, timeoutMs)
    const warnings: Warning[] = []

    const ctx: ToolContext = {
      signal: controller.signal,
      clock: this.#opts.clock,
      project: normalized.value,
      warn: (w) => warnings.push(w),
    }

    let data: unknown = null
    let error: ToolError | null = null
    try {
      const running = tool.handler({ ...input, project: normalized.value } as never, ctx)
      // Once abandoned below, its eventual rejection has nobody to reach.
      running.catch(() => {})
      const out = await Promise.race([running, abandonAfterAbort(controller.signal)])
      if (out.ok) data = out.value
      else error = out.error
    } catch (e) {
      // Throwing is a bug. It goes out as -32603 with no detail to the client.
      this.#opts.log('error', 'handler threw', {
        tool: name,
        requestId,
        client: clientInfo,
        error: e instanceof Error ? e.stack : String(e),
      })
      return failure(id, INTERNAL_ERROR, 'internal error', this.#errorTime())
    } finally {
      clearTimeout(timer)
      this.#inFlight.delete(id)
    }

    if (controller.signal.reason === CLIENT_CANCELLED) return null

    if (deadlineHit && (error === null || error.code === CoreErrors.CANCELLED)) {
      // Either the handler returned just as the deadline fired — a success whose
      // duration exceeds the declared timeout — or it reported the abort as a
      // cancellation. Both are the deadline, and the caller should read it so.
      error = toolError(CoreErrors.TIMEOUT, `the call exceeded its ${timeoutMs} ms deadline`)
    } else if (error === null && controller.signal.aborted) {
      error = toolError(CoreErrors.CANCELLED, 'the call was cancelled before completing')
    }

    let envelope = buildEnvelope({
      ...base,
      project: normalized.value,
      target: tool.target(parsed.data as never),
      data,
      error,
      warnings,
    })

    // Measurements become citable evidence, failed ones included: a refused
    // connection is as much a fact as a 200. A refusal by the server itself
    // observed nothing, and a reading of the registry is not evidence of itself.
    if (
      this.#opts.recordObservation !== undefined &&
      (error === null || !NOT_AN_OBSERVATION.has(error.code)) &&
      name.startsWith(`${MODULE_ID}.measure.`)
    ) {
      const recorded = await this.#recordSafely(envelope)
      if (!recorded.ok) {
        // The measurement itself stands; what the caller must learn is that its
        // observation_id will not resolve in recall.assert. Silence here would
        // surface later as OBSERVATION_NOT_FOUND with no trail back to the cause.
        envelope = {
          ...envelope,
          warnings: [
            ...envelope.warnings,
            {
              code: WarningCodes.OBSERVATION_NOT_RECORDED,
              message: 'the observation could not be stored and cannot be cited as evidence',
              detail: { reason: recorded.error.code },
            },
          ],
        }
      }
    }

    return success(id, this.#toolResult(envelope, error !== null))
  }

  /** Persisting must never fail the measurement the caller already holds. */
  async #recordSafely(envelope: Envelope<unknown>): Promise<Result<void>> {
    try {
      const result = await this.#opts.recordObservation!(envelope)
      if (!result.ok) {
        this.#opts.log('warn', 'could not record observation', {
          observation_id: envelope.observation_id,
          code: result.error.code,
        })
      }
      return result
    } catch (e) {
      this.#opts.log('error', 'recordObservation threw', {
        observation_id: envelope.observation_id,
        error: e instanceof Error ? e.stack : String(e),
      })
      return { ok: false, error: toolError(CoreErrors.STORAGE_ERROR, 'recording threw') }
    }
  }

  #toolResult(envelope: unknown, isError: boolean): Record<string, unknown> {
    return {
      resultType: 'complete',
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      structuredContent: envelope,
      isError,
      _meta: {
        [MetaKeys.serverInfo]: { name: this.#opts.info.name, version: this.#opts.info.version },
      },
    }
  }
}

/**
 * Settles ABORT_GRACE_MS after `signal` aborts, for racing against a handler
 * that does not honour it. Never settles if the signal does not abort; the
 * listener it leaves behind goes with the controller, which is per call.
 */
function abandonAfterAbort(signal: AbortSignal): Promise<Result<never>> {
  return new Promise((resolve) => {
    const giveUp = (): void => {
      setTimeout(
        () =>
          resolve({
            ok: false,
            error: toolError(CoreErrors.CANCELLED, 'the tool did not stop when its signal aborted'),
          }),
        ABORT_GRACE_MS,
      ).unref()
    }
    if (signal.aborted) giveUp()
    else signal.addEventListener('abort', giveUp, { once: true })
  })
}

/**
 * Composes the envelope schema around a tool's data schema.
 *
 * `data` is null whenever `error` is set, so the schema must admit null: a
 * client that validates structuredContent against outputSchema — as the v2 SDK
 * does — would otherwise reject every tool error. `$schema` is lifted out of the
 * nested schema because it is only meaningful at a document root.
 */
function envelopeSchema(dataSchema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _nested, ...data } = dataSchema
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      observation_id: { type: 'string', description: 'Citable id of this observation.' },
      request_id: { type: 'string', description: 'The request that produced it.' },
      tool: { type: 'string', description: 'Full tool name.' },
      project: { type: 'string', description: 'The normalized project.' },
      target: { type: 'object', description: 'Effective arguments, redacted.' },
      observed_at: { type: 'string', description: 'ISO 8601 with offset.' },
      age_seconds: { type: 'number', description: 'Seconds since observed_at.' },
      age_basis: { enum: ['monotonic', 'wall'], description: 'Which clock the age came from.' },
      duration_ms: { type: 'number', description: 'How long the observation took.' },
      ok: {
        type: 'boolean',
        description:
          'Whether the observation could be taken. NOT a judgement about what was observed: a cleanly received HTTP 500 is ok:true.',
      },
      error: { type: ['object', 'null'], description: 'What prevented observing, if anything.' },
      data: {
        anyOf: [data, { type: 'null' }],
        description: 'The raw observation, or null when error is set.',
      },
      warnings: { type: 'array', description: 'Non-fatal notices.' },
    },
    required: [
      'observation_id',
      'request_id',
      'tool',
      'project',
      'target',
      'observed_at',
      'age_seconds',
      'age_basis',
      'duration_ms',
      'ok',
      'error',
      'data',
      'warnings',
    ],
  }
}
