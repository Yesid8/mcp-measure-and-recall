import { z } from 'zod'
import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { defineTool, type ToolContext } from '../kernel/tool.js'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../kernel/result.js'
import { WarningCodes } from '../kernel/envelope.js'
import { toIsoWithOffset } from '../kernel/clock.js'
import {
  WS_SCHEMES,
  resolveAndValidate,
  tlsPeer,
  type NetPolicy,
  type ResolvedTarget,
} from '../policy/net.js'
import { decodePayload, mapSocketError } from './wire.js'

/**
 * facts.measure.ws — connect, listen for N seconds, return what arrived.
 *
 * The listen always runs for the full requested time unless the server closes
 * or the caller cancels. Zero messages in N seconds is a perfectly valid
 * observation: ok:true, message_count 0. It is not an error, and this tool does
 * not say whether silence is a problem.
 *
 * A minimal RFC 6455 client, because the policy requires connecting to the
 * validated IP while keeping the original Host and SNI, and no off-the-shelf
 * client exposes that. Only what a measurement needs: no reconnection, no
 * extensions. Fragmented messages are reassembled on receive, because a half
 * message reported as a whole one would be a measurement of something nobody
 * sent; this client never fragments what it sends.
 */

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F'

/** Budget for DNS, TCP, TLS and the upgrade, before the listen window starts. */
const CONNECT_BUDGET_MS = 30_000

const input = z
  .object({
    project: z.string().min(1).describe('Project this observation belongs to.'),
    url: z.string().min(1).describe('ws:// or wss:// URL. Subject to the network policy.'),
    listen_seconds: z
      .number()
      .min(0.1)
      .max(120)
      .describe('How long to listen. The full time is always served unless the peer closes.'),
    headers: z.record(z.string(), z.string()).default({}).describe('Handshake headers, e.g. auth.'),
    subprotocols: z.array(z.string()).default([]).describe('Requested subprotocols.'),
    send: z
      .array(
        z.object({
          payload: z
            .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
            .describe('Text, or an object serialized to JSON.'),
          delay_ms: z
            .number()
            .int()
            .min(0)
            .max(120_000)
            .default(0)
            .describe('Delay after opening.'),
        }),
      )
      .default([])
      .describe('Messages to send once the socket is open.'),
    max_messages: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(1000)
      .describe(
        'Stop recording received messages at this many; listening continues for the full time. Does not count your own send messages.',
      ),
    max_message_bytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(65_536)
      .describe('Per-message cap; larger payloads are truncated.'),
    max_total_bytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .default(8_388_608)
      .describe('Aggregate cap across received messages.'),
  })
  .strict()

export type MeasureWsInput = z.infer<typeof input>

const output = z
  .object({
    kind: z.literal('ws').describe('Discriminator of the observation type.'),
    connected: z.boolean().describe('Whether the handshake completed.'),
    opened_at: z.string().nullable().describe('When the socket opened, ISO 8601 with offset.'),
    handshake_ms: z.number().nullable().describe('How long the upgrade took.'),
    negotiated_subprotocol: z
      .string()
      .nullable()
      .describe('What the server selected, if anything.'),
    closed: z
      .union([
        z.object({
          at: z.string().describe('When it closed.'),
          code: z.number().nullable().describe('Close code as sent.'),
          reason: z.string().describe('Close reason as sent.'),
          by: z.enum(['server', 'client', 'timeout']).describe('Who closed it.'),
        }),
        z.null(),
      ])
      .describe('How the connection ended.'),
    listen_seconds_requested: z.number().describe('What was asked for.'),
    listen_seconds_actual: z.number().describe('What actually elapsed.'),
    messages: z
      .array(
        z.object({
          seq: z.number().describe('Order of arrival.'),
          at: z.string().describe('Absolute time, ISO 8601 with offset.'),
          offset_ms: z.number().describe('Milliseconds since the socket opened.'),
          direction: z.enum(['in', 'out']).describe('Received or sent.'),
          type: z.enum(['text', 'binary']).describe('Frame type.'),
          bytes: z.number().describe('Payload size.'),
          payload: z.unknown().describe('The payload. Never interpreted.'),
          payload_format: z.enum(['json', 'text', 'base64']).describe('How it was encoded.'),
        }),
      )
      .describe('Messages in order, each with its own absolute time and offset.'),
    message_count: z.number().describe('How many were recorded.'),
    messages_truncated: z.boolean().describe('Whether a cap stopped accumulation.'),
    bytes_total: z.number().describe('Total payload bytes of received messages recorded.'),
  })
  .strict()

export type MeasureWsData = z.infer<typeof output>

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

interface Frame {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Buffer
}

/**
 * Decodes whole frames from a buffer, returning the bytes left over.
 *
 * `rest` is a view, not a copy: the caller decides when to compact, so a large
 * message arriving in many chunks does not pay a copy of the whole remainder
 * per chunk.
 */
function decodeFrames(buf: Buffer): { frames: Frame[]; rest: Buffer; malformed: boolean } {
  const frames: Frame[] = []
  let offset = 0

  while (offset + 2 <= buf.length) {
    const first = buf[offset]!
    const second = buf[offset + 1]!
    const fin = (first & 0x80) !== 0
    // RSV bits imply an extension. We negotiate none, so a frame carrying them
    // is not ours to interpret: report it rather than decode it as if it were.
    if ((first & 0x70) !== 0) return { frames, rest: buf.subarray(offset), malformed: true }

    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let len = second & 0x7f
    let cursor = offset + 2

    if (len === 126) {
      if (cursor + 2 > buf.length) break
      len = buf.readUInt16BE(cursor)
      cursor += 2
    } else if (len === 127) {
      if (cursor + 8 > buf.length) break
      const big = buf.readBigUInt64BE(cursor)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { frames, rest: buf.subarray(offset), malformed: true }
      }
      len = Number(big)
      cursor += 8
    }

    let maskKey: Buffer | null = null
    if (masked) {
      if (cursor + 4 > buf.length) break
      maskKey = buf.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + len > buf.length) break

    // Copied because unmasking writes in place and the source buffer is shared.
    const payload = Buffer.from(buf.subarray(cursor, cursor + len))
    if (maskKey !== null) {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!
    }
    frames.push({ fin, opcode, payload })
    offset = cursor + len
  }
  return { frames, rest: buf.subarray(offset), malformed: false }
}

/** The client's half of the RFC 6455 opening handshake. */
function buildUpgradeRequest(target: ResolvedTarget, key: string, i: MeasureWsInput): string {
  const lines = [
    `GET ${target.url.pathname}${target.url.search} HTTP/1.1`,
    // Host carries the original name even though we connect to a pinned IP.
    `Host: ${target.url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ]
  if (i.subprotocols.length > 0) {
    lines.push(`Sec-WebSocket-Protocol: ${i.subprotocols.join(', ')}`)
  }
  for (const [k, v] of Object.entries(i.headers)) lines.push(`${k}: ${v}`)
  return lines.join('\r\n') + '\r\n\r\n'
}

/**
 * Validates the server's half of the handshake.
 *
 * The Sec-WebSocket-Accept check is not ceremony: it proves the peer actually
 * understood the upgrade rather than a proxy echoing a 101 at us.
 */
function parseUpgradeResponse(
  head: string,
  expectedAccept: string,
): Result<{ negotiatedSubprotocol: string | null }> {
  const statusLine = head.split('\r\n')[0] ?? ''
  if (!statusLine.includes('101')) {
    return Err(
      toolError(ErrorCodes.WS_HANDSHAKE_FAILED, `the upgrade was refused: ${statusLine}`, {
        detail: { status_line: statusLine },
      }),
    )
  }
  if (/sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1] !== expectedAccept) {
    return Err(toolError(ErrorCodes.WS_HANDSHAKE_FAILED, 'Sec-WebSocket-Accept did not match'))
  }
  return Ok({
    negotiatedSubprotocol: /sec-websocket-protocol:\s*(\S+)/i.exec(head)?.[1] ?? null,
  })
}

/**
 * Reassembles fragmented messages (RFC 6455 §5.4).
 *
 * A server may split one message into a first frame with FIN=0 and any number
 * of continuations. Reporting the first fragment as a whole message would hand
 * back something nobody sent — half a JSON document presented as the payload —
 * so the pieces are joined and only the completed message is emitted.
 */
class MessageAssembler {
  #opcode: number | null = null
  #parts: Buffer[] = []
  #bytes = 0

  /** Returns a completed message, or null while one is still being assembled. */
  accept(frame: Frame): { opcode: number; payload: Buffer } | null {
    if (frame.opcode === OP_CONTINUATION) {
      // A continuation with nothing started is a protocol error on their side;
      // dropping it is better than emitting a fragment as a message.
      if (this.#opcode === null) return null
      this.#parts.push(frame.payload)
      this.#bytes += frame.payload.length
    } else {
      this.#opcode = frame.opcode
      this.#parts = [frame.payload]
      this.#bytes = frame.payload.length
    }

    if (!frame.fin) return null

    const opcode = this.#opcode
    const payload =
      this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts, this.#bytes)
    this.#opcode = null
    this.#parts = []
    this.#bytes = 0
    return opcode === null ? null : { opcode, payload }
  }

  get pending(): boolean {
    return this.#opcode !== null
  }
}

/** Client frames must be masked (RFC 6455 §5.3). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!

  const len = masked.length
  const header: number[] = [0x80 | opcode]
  if (len < 126) header.push(0x80 | len)
  else if (len < 65_536) header.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff)
  else {
    header.push(0x80 | 127)
    for (let i = 7; i >= 0; i--) header.push(Number((BigInt(len) >> BigInt(8 * i)) & 0xffn))
  }
  return Buffer.concat([Buffer.from(header), mask, masked])
}

/** facts.measure.ws, bound to the network policy the connection must pass. */
export function createMeasureWs(policy: NetPolicy) {
  return defineTool({
    name: 'measure.ws',
    title: 'Measure WebSocket',
    description:
      "Connect to a WebSocket, listen for a given number of seconds, and return the messages that arrived, each with its absolute time and its offset from the open. Measures from the server's network position. Zero messages is a valid observation, not an error: it does NOT wait for a particular message, does not interpret payloads, does not reconnect, and does not say whether silence is a problem.",
    input,
    output,
    annotations: { readOnlyHint: true, openWorldHint: true },
    records: true,
    // Above the 120 s maximum of listen_seconds; the connect budget is bounded
    // separately inside the handler.
    timeoutMs: 130_000,
    target: (i) => ({
      url: i.url,
      listen_seconds: i.listen_seconds,
      headers: i.headers,
      subprotocols: i.subprotocols,
      send: i.send,
      max_messages: i.max_messages,
      max_message_bytes: i.max_message_bytes,
      max_total_bytes: i.max_total_bytes,
    }),
    handler: async (i, ctx): Promise<Result<MeasureWsData>> => {
      const validated = await resolveAndValidate(i.url, policy, ctx.signal, WS_SCHEMES)
      if (!validated.ok) return Err(validated.error)
      const listen = new WsListen(validated.value, i, ctx)
      const ended = await listen.run()
      if (!ended.ok) return Err(ended.error)
      listen.reportWarnings()
      return Ok(listen.observation())
    },
  })
}

type Message = MeasureWsData['messages'][number]

/**
 * One listen: connect, upgrade, hear frames for the window, then report.
 *
 * Its state is everything the observation is made of. Each socket event has a
 * method of its own, and every way the listen can end goes through end(),
 * which is idempotent: a socket can emit several of them, and only the first
 * says how the connection ended.
 */
class WsListen {
  readonly #target: ResolvedTarget
  readonly #i: MeasureWsInput
  readonly #ctx: ToolContext
  readonly #key = randomBytes(16).toString('base64')
  readonly #started: number

  #socket: Socket | null = null
  readonly #assembler = new MessageAssembler()
  readonly #messages: Message[] = []
  /** Every timer scheduled, so end() clears them all without waiting for 'close'. */
  readonly #timers = new Set<NodeJS.Timeout>()
  #buffer: Buffer = Buffer.alloc(0)
  #seq = 0
  #inboundCount = 0
  #inboundBytes = 0
  #truncated = false
  #protocolFault = false
  #openedAt: Date | null = null
  #openedMonotonic = 0
  #handshakeMs: number | null = null
  #negotiated: string | null = null
  #closed: MeasureWsData['closed'] = null
  #settle: ((r: Result<void>) => void) | null = null

  constructor(target: ResolvedTarget, i: MeasureWsInput, ctx: ToolContext) {
    this.#target = target
    this.#i = i
    this.#ctx = ctx
    this.#started = ctx.clock.monotonic()
  }

  /** Resolves when the listen ends: the window elapsed, the peer closed, or it failed. */
  run(): Promise<Result<void>> {
    return new Promise((resolve) => {
      this.#settle = resolve
      const { address, port, url } = this.#target
      const socket: Socket =
        url.protocol === 'wss:'
          ? tlsConnect({ host: address, port, ...tlsPeer(this.#target) })
          : netConnect({ host: address, port })
      this.#socket = socket

      // Bounds what happens before the window opens — DNS, TCP, TLS and the
      // upgrade — so the call cannot hang on a peer that accepts a connection
      // and then says nothing. The window itself is scheduled on open.
      this.#schedule(
        () => this.#close('timeout', null, ''),
        this.#i.listen_seconds * 1000 + CONNECT_BUDGET_MS,
      )

      this.#ctx.signal.addEventListener('abort', this.#onAbort, { once: true })
      // addEventListener does not fire for a signal that is already aborted,
      // which would leave the socket open until the outer bound expires.
      if (this.#ctx.signal.aborted) this.#onAbort()

      // `on`, not `once`: an 'error' with no listener crashes the whole process,
      // and a socket can emit a second one after the first. Shared with
      // measure.http, because error codes are public contract and the same
      // socket failure must not surface under two different names.
      socket.on('error', (e: NodeJS.ErrnoException) => this.#end(Err(mapSocketError(e))))
      socket.once('connect', () =>
        socket.write(buildUpgradeRequest(this.#target, this.#key, this.#i)),
      )
      socket.on('data', (chunk: Buffer) => this.#onData(chunk))
      socket.once('close', () => {
        if (this.#openedAt !== null) this.#close('server', null, '')
      })
    })
  }

  /** The warnings that tell the caller where the observation is incomplete. */
  reportWarnings(): void {
    if (this.#protocolFault) {
      // The window was cut short, and the caller must not read the message
      // list as "everything that arrived in N seconds".
      this.#ctx.warn({
        code: WarningCodes.WS_PROTOCOL_ERROR,
        message: 'the peer sent a frame this client cannot interpret; the listen ended early',
      })
    }
    if (this.#assembler.pending) {
      this.#ctx.warn({
        code: WarningCodes.WS_MESSAGE_INCOMPLETE,
        message:
          'the listen ended while a fragmented message was still arriving; it is not reported',
      })
    }
    if (this.#truncated) {
      this.#ctx.warn({
        code: WarningCodes.MESSAGES_TRUNCATED,
        message: 'message accumulation hit a cap; listening continued for the full window',
        detail: {
          max_messages: this.#i.max_messages,
          max_message_bytes: this.#i.max_message_bytes,
          max_total_bytes: this.#i.max_total_bytes,
        },
      })
    }
  }

  observation(): MeasureWsData {
    const opened = this.#openedAt
    return {
      kind: 'ws',
      connected: opened !== null,
      opened_at: opened === null ? null : toIsoWithOffset(opened),
      handshake_ms: this.#handshakeMs,
      negotiated_subprotocol: this.#negotiated,
      closed: this.#closed,
      listen_seconds_requested: this.#i.listen_seconds,
      listen_seconds_actual:
        opened === null ? 0 : (this.#ctx.clock.monotonic() - this.#openedMonotonic) / 1000,
      messages: this.#messages,
      message_count: this.#messages.length,
      messages_truncated: this.#truncated,
      bytes_total: this.#inboundBytes,
    }
  }

  readonly #onAbort = (): void => {
    this.#recordClose('client', null, 'cancelled')
    this.#end(Err(toolError(ErrorCodes.CANCELLED, 'the call was cancelled')))
  }

  #onData(chunk: Buffer): void {
    // An empty remainder is the common case once frames are being consumed;
    // taking the chunk as-is avoids a copy per event.
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])

    if (this.#openedAt === null) {
      const sep = this.#buffer.indexOf('\r\n\r\n')
      if (sep === -1) return
      const head = this.#buffer.subarray(0, sep).toString('utf8')
      this.#buffer = this.#buffer.subarray(sep + 4)
      if (!this.#open(head)) return
    }

    const { frames, rest, malformed } = decodeFrames(this.#buffer)
    this.#buffer = rest
    if (malformed) {
      this.#protocolFault = true
      this.#close('client', 1002, 'protocol error')
      return
    }
    for (const frame of frames) {
      if (!this.#onFrame(frame)) return
    }
  }

  /** Completes the upgrade and starts the window. False if the upgrade failed. */
  #open(head: string): boolean {
    const accept = createHash('sha1')
      .update(this.#key + GUID)
      .digest('base64')
    const upgrade = parseUpgradeResponse(head, accept)
    if (!upgrade.ok) {
      this.#end(Err(upgrade.error))
      return false
    }
    this.#negotiated = upgrade.value.negotiatedSubprotocol
    this.#openedAt = this.#ctx.clock.now()
    this.#openedMonotonic = this.#ctx.clock.monotonic()
    this.#handshakeMs = this.#openedMonotonic - this.#started

    // The connect bound is over; the window starts now and always runs its full length.
    this.#clearTimers()
    this.#schedule(() => this.#close('timeout', null, ''), this.#i.listen_seconds * 1000)
    for (const msg of this.#i.send) {
      if (msg.delay_ms === 0) this.#send(msg.payload)
      else this.#schedule(() => this.#send(msg.payload), msg.delay_ms)
    }
    return true
  }

  /** Handles one frame. False when it ended the listen. */
  #onFrame(frame: Frame): boolean {
    if (frame.opcode === OP_CLOSE) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null
      this.#close('server', code, frame.payload.subarray(2).toString('utf8'))
      return false
    }
    // Control frames are never fragmented and never become messages.
    if (frame.opcode === OP_PING) {
      this.#socket?.write(encodeFrame(OP_PONG, frame.payload))
      return true
    }
    if (frame.opcode === OP_PONG) return true

    const message = this.#assembler.accept(frame)
    if (message !== null) this.#receive(message.opcode, message.payload)
    return true
  }

  /**
   * Records a received message within the caps. The caps bound what was
   * RECEIVED — that is the observation; the caller's own `send` messages are
   * few and deliberate, and counting them would shrink its inbound budget.
   */
  #receive(opcode: number, payload: Buffer): void {
    const i = this.#i
    if (this.#inboundCount >= i.max_messages || this.#inboundBytes >= i.max_total_bytes) {
      // Stop accumulating, but keep listening: the caller asked for a window of
      // time, and cutting it short would misreport the window.
      this.#truncated = true
      return
    }
    // Byte cap by design; the last multibyte character may be split, which
    // decodePayload surfaces as replacement text or non-JSON.
    const capped = payload.subarray(0, i.max_message_bytes)
    if (capped.length < payload.length) this.#truncated = true
    this.#inboundCount += 1
    this.#inboundBytes += capped.length
    const isText = opcode === OP_TEXT
    this.#push('in', isText ? 'text' : 'binary', capped)
  }

  #send(payload: MeasureWsInput['send'][number]['payload']): void {
    if (this.#settle === null) return // the listen already ended
    const buf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
    this.#socket?.write(encodeFrame(OP_TEXT, buf))
    this.#push('out', 'text', buf)
  }

  #push(direction: Message['direction'], type: Message['type'], buf: Buffer): void {
    const decoded = decodePayload(buf, type === 'text')
    this.#messages.push({
      seq: ++this.#seq,
      at: toIsoWithOffset(this.#ctx.clock.now()),
      offset_ms: this.#ctx.clock.monotonic() - this.#openedMonotonic,
      direction,
      type,
      bytes: buf.length,
      payload: decoded.payload,
      payload_format: decoded.format,
    })
  }

  /** Ends the listen normally, saying who closed it. */
  #close(by: 'server' | 'client' | 'timeout', code: number | null, reason: string): void {
    this.#recordClose(by, code, reason)
    this.#end(Ok(undefined))
  }

  /** Only the first close is the real one. */
  #recordClose(by: 'server' | 'client' | 'timeout', code: number | null, reason: string): void {
    this.#closed ??= { at: toIsoWithOffset(this.#ctx.clock.now()), code, reason, by }
  }

  #end(result: Result<void>): void {
    const settle = this.#settle
    if (settle === null) return
    this.#settle = null
    this.#clearTimers()
    this.#ctx.signal.removeEventListener('abort', this.#onAbort)
    this.#socket?.destroy()
    settle(result)
  }

  #schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.#timers.delete(t)
      fn()
    }, ms)
    this.#timers.add(t)
  }

  #clearTimers(): void {
    for (const t of this.#timers) clearTimeout(t)
    this.#timers.clear()
  }
}
