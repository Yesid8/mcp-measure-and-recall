import { z } from 'zod'
import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { defineTool } from '../kernel/tool.js'
import { CoreErrors, Err, Ok, toolError, type Result } from '../kernel/result.js'
import { WarningCodes } from '../kernel/envelope.js'
import { toIsoWithOffset } from '../kernel/clock.js'
import {
  WS_SCHEMES,
  resolveAndValidate,
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
      toolError('WS_HANDSHAKE_FAILED', `the upgrade was refused: ${statusLine}`, {
        detail: { status_line: statusLine },
      }),
    )
  }
  if (/sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1] !== expectedAccept) {
    return Err(toolError('WS_HANDSHAKE_FAILED', 'Sec-WebSocket-Accept did not match'))
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
      const target = validated.value

      const started = ctx.clock.monotonic()
      const key = randomBytes(16).toString('base64')
      const expectedAccept = createHash('sha1')
        .update(key + GUID)
        .digest('base64')

      const isTls = target.url.protocol === 'wss:'
      const socket: Socket = isTls
        ? tlsConnect({
            host: target.address,
            port: target.port,
            servername: target.hostname,
            rejectUnauthorized: true,
          })
        : netConnect({ host: target.address, port: target.port })

      const messages: Array<MeasureWsData['messages'][number]> = []
      const assembler = new MessageAssembler()
      let protocolFault = false
      let inboundCount = 0
      let inboundBytes = 0
      let truncated = false
      let seq = 0
      let openedAt: Date | null = null
      let openedMonotonic = 0
      let handshakeMs: number | null = null
      let negotiated: string | null = null
      let closed: MeasureWsData['closed'] = null

      const finish = (by: 'server' | 'client' | 'timeout', code: number | null, reason: string) => {
        if (closed === null) {
          closed = { at: toIsoWithOffset(ctx.clock.now()), code, reason, by }
        }
      }

      const result = await new Promise<Result<void>>((resolve) => {
        // Every timer this call schedules, so done() can clear them directly
        // instead of relying on socket.destroy() emitting 'close' for each.
        const timers = new Set<NodeJS.Timeout>()
        const schedule = (fn: () => void, ms: number): NodeJS.Timeout => {
          const t = setTimeout(() => {
            timers.delete(t)
            fn()
          }, ms)
          timers.add(t)
          return t
        }

        let settled = false
        const done = (r: Result<void>) => {
          if (settled) return
          settled = true
          for (const t of timers) clearTimeout(t)
          timers.clear()
          ctx.signal.removeEventListener('abort', onAbort)
          socket.destroy()
          resolve(r)
        }

        // Covers the case where the socket never opens at all. The listen
        // window itself is scheduled on open; this only bounds the time spent
        // before that — DNS, TCP, TLS and the upgrade — so the call cannot hang
        // on a peer that accepts a connection and then says nothing.
        const connectTimer = schedule(
          () => {
            finish('timeout', null, '')
            done(Ok(undefined))
          },
          i.listen_seconds * 1000 + CONNECT_BUDGET_MS,
        )

        const onAbort = () => {
          finish('client', null, 'cancelled')
          done(Err(toolError(CoreErrors.CANCELLED, 'the call was cancelled')))
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        // addEventListener does not fire for a signal that is already aborted,
        // which would leave the socket open until the outer bound expires.
        if (ctx.signal.aborted) onAbort()

        // `on`, not `once`: an 'error' with no listener crashes the whole
        // process, and a socket can emit a second one after the first. done()
        // is idempotent, so later errors are simply absorbed.
        socket.on('error', (e: NodeJS.ErrnoException) => {
          // Shared with measure.http: error codes are public contract, so the
          // same socket failure must not surface under two different names.
          done(Err(mapSocketError(e)))
        })

        socket.once('connect', () => {
          socket.write(buildUpgradeRequest(target, key, i))
        })

        let handshakeDone = false
        let buffer: Buffer = Buffer.alloc(0)

        socket.on('data', (chunk: Buffer) => {
          // An empty remainder is the common case once frames are being
          // consumed; taking the chunk as-is avoids a copy per event.
          buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

          if (!handshakeDone) {
            const sep = buffer.indexOf('\r\n\r\n')
            if (sep === -1) return
            const head = buffer.subarray(0, sep).toString('utf8')
            buffer = buffer.subarray(sep + 4)

            const upgrade = parseUpgradeResponse(head, expectedAccept)
            if (!upgrade.ok) {
              done(Err(upgrade.error))
              return
            }
            negotiated = upgrade.value.negotiatedSubprotocol

            handshakeDone = true
            openedAt = ctx.clock.now()
            openedMonotonic = ctx.clock.monotonic()
            handshakeMs = openedMonotonic - started

            // The listen window starts at the open, and always runs its full length.
            clearTimeout(connectTimer)
            timers.delete(connectTimer)
            schedule(() => {
              finish('timeout', null, '')
              done(Ok(undefined))
            }, i.listen_seconds * 1000)

            for (const msg of i.send) {
              const text =
                typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)
              const buf = Buffer.from(text, 'utf8')
              const write = () => {
                if (settled) return
                socket.write(encodeFrame(OP_TEXT, buf))
                const decoded = decodePayload(buf, true)
                messages.push({
                  seq: ++seq,
                  at: toIsoWithOffset(ctx.clock.now()),
                  offset_ms: ctx.clock.monotonic() - openedMonotonic,
                  direction: 'out',
                  type: 'text',
                  bytes: buf.length,
                  payload: decoded.payload,
                  payload_format: decoded.format,
                })
              }
              if (msg.delay_ms === 0) write()
              else schedule(write, msg.delay_ms)
            }
          }

          const { frames, rest, malformed } = decodeFrames(buffer)
          buffer = rest
          if (malformed) {
            protocolFault = true
            finish('client', 1002, 'protocol error')
            done(Ok(undefined))
            return
          }

          for (const frame of frames) {
            if (frame.opcode === OP_CLOSE) {
              const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null
              finish('server', code, frame.payload.subarray(2).toString('utf8'))
              done(Ok(undefined))
              return
            }
            // Control frames are never fragmented and never become messages.
            if (frame.opcode === OP_PING) {
              socket.write(encodeFrame(OP_PONG, frame.payload))
              continue
            }
            if (frame.opcode === OP_PONG) continue

            const message = assembler.accept(frame)
            if (message === null) continue

            // The caps bound what was RECEIVED — that is the observation. The
            // caller's own `send` messages are few and deliberate, so counting
            // them here would let the client shrink its own inbound budget.
            if (inboundCount >= i.max_messages || inboundBytes >= i.max_total_bytes) {
              // Stop accumulating, but keep listening: the caller asked for a
              // window of time, and cutting it short would misreport the window.
              truncated = true
              continue
            }

            // Byte cap by design; the last multibyte character may be split,
            // which decodePayload will surface as replacement text or non-JSON.
            const capped = message.payload.subarray(0, i.max_message_bytes)
            if (capped.length < message.payload.length) truncated = true
            inboundCount += 1
            inboundBytes += capped.length

            const isText = message.opcode === OP_TEXT
            const decoded = decodePayload(capped, isText)
            messages.push({
              seq: ++seq,
              at: toIsoWithOffset(ctx.clock.now()),
              offset_ms: ctx.clock.monotonic() - openedMonotonic,
              direction: 'in',
              type: isText ? 'text' : 'binary',
              bytes: capped.length,
              payload: decoded.payload,
              payload_format: decoded.format,
            })
          }
        })

        socket.once('close', () => {
          if (handshakeDone) {
            finish('server', null, '')
            done(Ok(undefined))
          }
        })
      })

      if (!result.ok) return Err(result.error)

      if (protocolFault) {
        // The listen ended early on a frame we cannot interpret. Saying so is
        // the honest report: the window was cut short and the caller must not
        // read the message list as "everything that arrived in N seconds".
        ctx.warn({
          code: WarningCodes.WS_PROTOCOL_ERROR,
          message: 'the peer sent a frame this client cannot interpret; the listen ended early',
        })
      }
      if (assembler.pending) {
        ctx.warn({
          code: WarningCodes.WS_MESSAGE_INCOMPLETE,
          message:
            'the listen ended while a fragmented message was still arriving; it is not reported',
        })
      }
      if (truncated) {
        ctx.warn({
          code: WarningCodes.MESSAGES_TRUNCATED,
          message: 'message accumulation hit a cap; listening continued for the full window',
          detail: {
            max_messages: i.max_messages,
            max_message_bytes: i.max_message_bytes,
            max_total_bytes: i.max_total_bytes,
          },
        })
      }

      return Ok({
        kind: 'ws' as const,
        connected: openedAt !== null,
        opened_at: openedAt === null ? null : toIsoWithOffset(openedAt),
        handshake_ms: handshakeMs,
        negotiated_subprotocol: negotiated,
        closed,
        listen_seconds_requested: i.listen_seconds,
        listen_seconds_actual:
          openedAt === null ? 0 : (ctx.clock.monotonic() - openedMonotonic) / 1000,
        messages,
        message_count: messages.length,
        messages_truncated: truncated,
        bytes_total: inboundBytes,
      })
    },
  })
}
