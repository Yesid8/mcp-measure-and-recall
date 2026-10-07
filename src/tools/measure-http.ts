import { z } from 'zod'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import type { Readable, Transform } from 'node:stream'
import { defineTool, type ToolContext } from '../kernel/tool.js'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../kernel/result.js'
import { WarningCodes } from '../kernel/envelope.js'
import {
  HTTP_SCHEMES,
  resolveAndValidate,
  tlsPeer,
  type NetPolicy,
  type ResolvedTarget,
} from '../policy/net.js'
import { mapSocketError } from './wire.js'
import { stripSecretKeys } from '../kernel/redact.js'

/**
 * facts.measure.http — one HTTP request, raw status and body.
 *
 * What it does not do: check whether the status is the one you expected (there
 * is no expect_status), validate the body against a schema, retry, follow
 * redirects unless asked, or forward credentials from the environment.
 */

/**
 * Real gzip over text rarely exceeds ~20:1, while a decompression bomb starts
 * in the thousands. A hundred leaves legitimate responses comfortable room and
 * still refuses the attack.
 */
const MAX_DECOMPRESSION_RATIO = 100

/** Hop cap when the policy sets none; only relevant when a caller asks to follow. */
export const DEFAULT_MAX_REDIRECTS = 5

const input = z
  .object({
    project: z.string().min(1).describe('Project this observation belongs to.'),
    url: z.string().min(1).describe('Absolute URL. Subject to the network policy.'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
      .default('GET')
      .describe('HTTP method.'),
    headers: z
      .record(z.string(), z.string())
      .default({})
      .describe('Request headers. Sent intact; redacted in the output and on disk.'),
    body: z
      .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
      .optional()
      .describe(
        'Request body. An object or array is serialized to JSON, with content-type application/json if absent; a string is sent as is.',
      ),
    timeout_ms: z.number().int().min(1).max(120_000).default(10_000).describe('Total timeout.'),
    follow_redirects: z
      .boolean()
      .default(false)
      .describe('When false, a 302 is returned as a 302. Each hop is revalidated by the policy.'),
    max_body_bytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .default(1_048_576)
      .describe('Body cap. On exceeding it the body is truncated and a warning is emitted.'),
  })
  .strict()

export type MeasureHttpInput = z.infer<typeof input>

const output = z
  .object({
    kind: z.literal('http').describe('Discriminator of the observation type.'),
    http_status: z.number().describe('The status code as received. 500 is a valid observation.'),
    status_text: z.string().describe('Reason phrase as sent by the server.'),
    http_version: z.string().describe('Negotiated HTTP version.'),
    headers: z.record(z.string(), z.string()).describe('Response headers, secrets redacted.'),
    body: z.unknown().describe('Parsed JSON, text, or a base64 string. Never interpreted.'),
    body_format: z
      .enum(['json', 'text', 'base64', 'none'])
      .describe('How the body was encoded, not what it means.'),
    body_bytes: z.number().describe('Body size in bytes as received.'),
    body_truncated: z.boolean().describe('Whether max_body_bytes cut the body short.'),
    timing_ms: z
      .object({
        dns: z.number().nullable().describe('Name resolution time.'),
        connect: z.number().nullable().describe('TCP connect time.'),
        ttfb: z.number().nullable().describe('Time to first byte.'),
        total: z.number().describe('Total wall time for the request.'),
      })
      .describe('Timings. Mechanical measurements, not a verdict on performance.'),
    redirect_chain: z
      .array(
        z.object({
          url: z.string().describe('The URL that answered with a redirect.'),
          http_status: z.number().describe('Its redirect status, as received.'),
        }),
      )
      .describe('Hops followed, if any.'),
    peer: z
      .object({
        address: z.string().describe('The IP actually connected to.'),
        port: z.number().describe('The port connected to.'),
        family: z.number().describe('4 or 6.'),
      })
      .describe('Which address was really reached. Part of the honesty of the measurement.'),
  })
  .strict()

export type MeasureHttpData = z.infer<typeof output>

interface OneShotResult {
  readonly res: IncomingMessage
  readonly peer: { address: string; port: number; family: number }
  readonly timing: { dns: number | null; connect: number | null; ttfb: number | null }
}

function decompressor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return null
  }
}

async function readBody(
  res: IncomingMessage,
  maxBytes: number,
  ctx: ToolContext,
): Promise<Result<{ buf: Buffer; truncated: boolean; rawBytes: number }>> {
  const stream = decompressor(res.headers['content-encoding'])
  const source: Readable = stream === null ? res : res.pipe(stream)
  const chunks: Buffer[] = []
  let total = 0
  let rawBytes = 0
  let truncated = false

  // Counting the compressed bytes is what makes the ratio check possible, and
  // it is only needed when there is something to decompress. Attaching it in
  // the uncompressed case would put `res` in flowing mode alongside the async
  // iterator already consuming it.
  const countRaw = (c: Buffer): number => (rawBytes += c.length)
  if (stream !== null) res.on('data', countRaw)

  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      if (ctx.signal.aborted) {
        res.destroy()
        return Err(toolError(ErrorCodes.CANCELLED, 'cancelled while reading the body'))
      }
      total += chunk.length
      if (stream !== null && rawBytes > 0 && total / rawBytes > MAX_DECOMPRESSION_RATIO) {
        res.destroy()
        return Err(
          toolError(
            ErrorCodes.DECOMPRESSION_LIMIT,
            'decompressed body exceeded the 100:1 ratio cap',
            {
              detail: { compressed_bytes: rawBytes, decompressed_bytes: total },
            },
          ),
        )
      }
      if (total > maxBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (total - chunk.length))))
        truncated = true
        res.destroy()
        break
      }
      chunks.push(chunk)
    }
  } catch (e) {
    if (!truncated) {
      return Err(
        toolError(ErrorCodes.BODY_READ_FAILED, 'the response body could not be read', { cause: e }),
      )
    }
  } finally {
    res.off('data', countRaw)
  }
  return Ok({ buf: Buffer.concat(chunks), truncated, rawBytes })
}

function oneShot(
  target: ResolvedTarget,
  input: MeasureHttpInput,
  bodyBuf: Buffer | null,
  ctx: ToolContext,
): Promise<Result<OneShotResult>> {
  return new Promise((resolve) => {
    const isTls = target.url.protocol === 'https:'
    const doRequest = isTls ? httpsRequest : httpRequest
    const started = ctx.clock.monotonic()
    let connectedAt: number | null = null
    const headers: Record<string, string> = { ...input.headers }
    // Host and SNI keep the ORIGINAL name; only the address is pinned.
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'host')) {
      headers['host'] = target.url.host
    }
    if (bodyBuf !== null) {
      const has = (name: string) => Object.keys(headers).some((h) => h.toLowerCase() === name)
      // Only a body this tool serialized is known to be JSON; a string goes out
      // exactly as given, labelled by the caller or not at all.
      if (typeof input.body !== 'string' && !has('content-type')) {
        headers['content-type'] = 'application/json'
      }
      // The body is already in memory, so its length is known. Without this
      // header Node sends it chunked, which small embedded servers often reject.
      if (!has('content-length')) headers['content-length'] = String(bodyBuf.length)
    }
    const req = doRequest({
      // Connect to the VALIDATED address, not the name.
      host: target.address,
      port: target.port,
      path: target.url.pathname + target.url.search,
      method: input.method,
      headers,
      ...(isTls ? tlsPeer(target) : {}),
      // No environment proxy: a legacy proxy would bypass the whole IP validation.
      agent: false,
      timeout: input.timeout_ms,
      signal: ctx.signal,
    })
    req.on('socket', (s) => {
      s.once('connect', () => (connectedAt = ctx.clock.monotonic()))
    })
    req.once('response', (res) => {
      const socket = res.socket
      resolve(
        Ok({
          res,
          peer: {
            address: socket?.remoteAddress ?? target.address,
            port: socket?.remotePort ?? target.port,
            family: target.family,
          },
          timing: {
            dns: null,
            connect: connectedAt === null ? null : connectedAt - started,
            ttfb: ctx.clock.monotonic() - started,
          },
        }),
      )
    })
    req.once('timeout', () => {
      req.destroy()
      resolve(Err(toolError(ErrorCodes.TIMEOUT, `no response within ${input.timeout_ms} ms`)))
    })
    // `on`, not `once`: the request can emit a second 'error' — during the body
    // read, after the response already resolved this promise — and an 'error'
    // with no listener crashes the whole process. Resolving twice is a no-op.
    req.on('error', (e: NodeJS.ErrnoException) => {
      resolve(Err(mapSocketError(e)))
    })
    if (bodyBuf !== null) req.write(bodyBuf)
    req.end()
  })
}

/** facts.measure.http, bound to the network policy every hop must pass. */
export function createMeasureHttp(policy: NetPolicy) {
  return defineTool({
    name: 'measure.http',
    title: 'Measure HTTP',
    description:
      "Make one HTTP request and return the raw status, headers and body, with the time it was observed and the IP actually connected to. Measures from the server's network position. It does NOT judge the result: a 500 received cleanly is a successful observation (ok:true, http_status 500). It does not check the status against an expectation, does not validate the body, does not retry, and does not follow redirects unless asked.",
    input,
    output,
    annotations: { readOnlyHint: true, openWorldHint: true },
    records: true,
    // Above the 120 s maximum of timeout_ms, which is the budget that should fire.
    timeoutMs: 130_000,
    target: (i) => ({
      url: i.url,
      method: i.method,
      headers: i.headers,
      timeout_ms: i.timeout_ms,
      follow_redirects: i.follow_redirects,
      max_body_bytes: i.max_body_bytes,
      ...(i.body !== undefined ? { body: i.body } : {}),
    }),
    handler: async (i, ctx): Promise<Result<MeasureHttpData>> => {
      // timeout_ms is the TOTAL budget, as documented. http.request's own
      // `timeout` only measures socket inactivity: a peer trickling one byte at
      // a time never trips it, and each redirect hop would start a fresh one.
      // One signal bounds the whole exchange — every hop, headers and body.
      const budget = AbortSignal.timeout(i.timeout_ms)
      const out = await exchange(
        i,
        { ...ctx, signal: AbortSignal.any([ctx.signal, budget]) },
        policy,
      )
      if (out.ok) return out
      // An abort surfaces from deep in the stack under whatever name the layer
      // that noticed gave it; the cause is known here, so name it correctly.
      if (ctx.signal.aborted) return Err(toolError(ErrorCodes.CANCELLED, 'the call was cancelled'))
      if (budget.aborted) {
        return Err(toolError(ErrorCodes.TIMEOUT, `no complete response within ${i.timeout_ms} ms`))
      }
      return out
    },
  })
}

/**
 * Where a response redirects to: a URL, null when it is not a redirect, or
 * 'invalid' when it is one with a Location that does not parse. The header is
 * chosen by the peer being measured, so a bad one must yield an observation,
 * not an exception.
 */
function redirectTarget(
  status: number,
  location: string | undefined,
  base: string,
): URL | null | 'invalid' {
  if (status < 300 || status >= 400 || location === undefined) return null
  try {
    return new URL(location, base)
  } catch {
    return 'invalid'
  }
}

function withoutKeys(
  headers: Readonly<Record<string, string>>,
  drop: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !drop.includes(k.toLowerCase())),
  )
}

/** The request as it goes out on one hop. Following a redirect may rewrite any of it. */
interface Hop {
  readonly url: string
  readonly method: MeasureHttpInput['method']
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer | null
}

/** One request, following redirects when asked. The caller owns the time budget. */
async function exchange(
  i: MeasureHttpInput,
  ctx: ToolContext,
  policy: NetPolicy,
): Promise<Result<MeasureHttpData>> {
  const started = ctx.clock.monotonic()
  const maxHops = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const redirectChain: { url: string; http_status: number }[] = []
  let hop: Hop = {
    url: i.url,
    method: i.method,
    headers: { ...i.headers },
    body:
      i.body === undefined
        ? null
        : Buffer.from(typeof i.body === 'string' ? i.body : JSON.stringify(i.body), 'utf8'),
  }

  for (let n = 0; ; n++) {
    // Step 7: every redirect hop repeats the full validation. No exceptions.
    const validated = await resolveAndValidate(hop.url, policy, ctx.signal, HTTP_SCHEMES)
    if (!validated.ok) return Err(validated.error)
    // Only the first hop is attributed: later hops resolve again, so null
    // means "not attributed", not "no DNS happened".
    const dnsMs = n === 0 ? ctx.clock.monotonic() - started : null
    const shot = await oneShot(
      validated.value,
      { ...i, url: hop.url, method: hop.method, headers: { ...hop.headers } },
      hop.body,
      ctx,
    )
    if (!shot.ok) return Err(shot.error)

    const status = shot.value.res.statusCode ?? 0
    const next = i.follow_redirects ? nextHopUrl(shot.value.res, hop.url, n, maxHops, ctx) : null
    if (next === null) {
      return observe(shot.value, i, ctx, {
        dns: dnsMs,
        total: () => ctx.clock.monotonic() - started,
        redirectChain,
      })
    }
    redirectChain.push({ url: hop.url, http_status: status })
    shot.value.res.resume() // drain, we are not keeping this body
    hop = followTo(hop, status, next, ctx)
  }
}

/**
 * Where to go next: the redirect's target, or null to return this response as
 * received — because it is not a redirect, its Location does not parse, or the
 * hop limit is reached. The last two say so in a warning.
 */
function nextHopUrl(
  res: IncomingMessage,
  currentUrl: string,
  hopsSoFar: number,
  maxHops: number,
  ctx: ToolContext,
): URL | null {
  const location = res.headers['location']
  const next = redirectTarget(res.statusCode ?? 0, location, currentUrl)
  if (next === 'invalid') {
    ctx.warn({
      code: WarningCodes.REDIRECT_NOT_FOLLOWED,
      message: 'the Location header is not a valid URL; the redirect is returned as received',
      detail: { location },
    })
    return null
  }
  if (next !== null && hopsSoFar >= maxHops) {
    ctx.warn({
      code: WarningCodes.REDIRECT_NOT_FOLLOWED,
      message: `stopped after ${maxHops} redirects; the last one is returned as received`,
      detail: { max_redirects: maxHops, location: next.toString() },
    })
    return null
  }
  return next
}

/**
 * The request for the next hop, behaving as the client the caller believes
 * they are — so remeasure_with reproduces a request that actually happened.
 * This is not interpreting the result.
 */
function followTo(hop: Hop, status: number, next: URL, ctx: ToolContext): Hop {
  let { method, body, headers } = hop
  // 303 always becomes GET; 301/302 become GET for anything but GET/HEAD, by
  // universal convention. Headers describing the dropped body would describe
  // nothing now.
  if (
    status === 303 ||
    ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')
  ) {
    method = 'GET'
    body = null
    headers = withoutKeys(headers, ['content-type', 'content-length'])
  }

  // Credentials are scoped to the origin they were given for. The policy
  // revalidates every hop, but a permitted host is not thereby entitled to a
  // token meant for another one.
  const from = new URL(hop.url).origin
  if (next.origin !== from) {
    const kept = stripSecretKeys(headers)
    if (Object.keys(kept).length !== Object.keys(headers).length) {
      ctx.warn({
        code: WarningCodes.CREDENTIALS_DROPPED_ON_REDIRECT,
        message: 'credential headers were not forwarded across an origin change',
        detail: { from, to: next.origin },
      })
    }
    headers = kept
  }
  return { url: next.toString(), method, headers, body }
}

/** Reads the final response and turns it into the observation. */
async function observe(
  { res, peer, timing }: OneShotResult,
  i: MeasureHttpInput,
  ctx: ToolContext,
  run: {
    readonly dns: number | null
    readonly total: () => number
    readonly redirectChain: readonly { url: string; http_status: number }[]
  },
): Promise<Result<MeasureHttpData>> {
  const read = await readBody(res, i.max_body_bytes, ctx)
  if (!read.ok) return Err(read.error)
  const { buf, truncated } = read.value
  const contentType = String(res.headers['content-type'] ?? '')
  const { body, format } = decodeBody(buf, contentType, truncated, ctx)
  if (truncated) {
    ctx.warn({
      code: WarningCodes.BODY_TRUNCATED,
      message: `body was truncated at ${i.max_body_bytes} bytes`,
      detail: { max_body_bytes: i.max_body_bytes },
    })
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(res.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
  }
  return Ok({
    kind: 'http' as const,
    http_status: res.statusCode ?? 0,
    status_text: res.statusMessage ?? '',
    http_version: res.httpVersion,
    headers,
    body,
    body_format: format,
    body_bytes: buf.length,
    body_truncated: truncated,
    timing_ms: {
      dns: run.dns,
      connect: timing.connect,
      ttfb: timing.ttfb,
      total: run.total(),
    },
    redirect_chain: [...run.redirectChain],
    peer,
  })
}

function decodeBody(
  buf: Buffer,
  contentType: string,
  truncated: boolean,
  ctx: ToolContext,
): { body: unknown; format: 'json' | 'text' | 'base64' | 'none' } {
  if (buf.length === 0) return { body: null, format: 'none' }
  const ct = contentType.toLowerCase()
  const looksJson = ct.includes('json')
  const looksText =
    ct.startsWith('text/') || ct.includes('xml') || ct.includes('urlencoded') || ct === ''
  if (looksJson && !truncated) {
    try {
      return { body: JSON.parse(buf.toString('utf8')) as unknown, format: 'json' }
    } catch {
      // Declared JSON and did not parse: return the text as-is with a warning.
      // No correcting it, no opinion about it.
      ctx.warn({
        code: WarningCodes.BODY_CONTENT_TYPE_MISMATCH,
        message: 'content-type declares JSON but the body did not parse as JSON',
        detail: { content_type: contentType },
      })
      return { body: buf.toString('utf8'), format: 'text' }
    }
  }
  if (looksJson || looksText) return { body: buf.toString('utf8'), format: 'text' }
  return { body: buf.toString('base64'), format: 'base64' }
}
