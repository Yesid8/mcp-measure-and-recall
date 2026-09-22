import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'

/**
 * A minimal WebSocket server for measurement tests.
 *
 * Named behaviours cover the common cases; `script` lets a test write exact
 * frames — any length encoding, masked or not, reserved bits set — to reach
 * the decoder's edges. Every frame the client sends is recorded in `received`.
 */

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F'

export type WsBehaviour = 'silent' | 'periodic' | 'close-midway' | 'refuse' | 'echo' | 'fragmented'

export interface WsFixtureOptions {
  readonly behaviour?: WsBehaviour
  /** Runs after a successful upgrade, with the raw socket. */
  readonly script?: (socket: Duplex) => void
  /** Echoed back as the negotiated subprotocol. */
  readonly subprotocol?: string
  /** Sends a wrong Sec-WebSocket-Accept, to exercise the handshake check. */
  readonly badAccept?: boolean
}

export interface ReceivedFrame {
  readonly opcode: number
  readonly payload: Buffer
}

export interface WsFixture {
  readonly port: number
  readonly origin: string
  readonly connections: number
  /** Frames the client sent, unmasked. */
  readonly received: readonly ReceivedFrame[]
  close(): Promise<void>
}

/** One frame, with every header field under the caller's control. */
export function rawFrame(opts: {
  opcode: number
  payload: Buffer | string
  fin?: boolean
  rsv?: number
  mask?: boolean
}): Buffer {
  const payload = typeof opts.payload === 'string' ? Buffer.from(opts.payload) : opts.payload
  const first = ((opts.fin ?? true) ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opts.opcode
  const maskBit = opts.mask === true ? 0x80 : 0
  const len = payload.length
  const header: number[] = [first]
  if (len < 126) header.push(maskBit | len)
  else if (len < 65_536) header.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff)
  else {
    header.push(maskBit | 127)
    for (let i = 7; i >= 0; i--) header.push(Number((BigInt(len) >> BigInt(8 * i)) & 0xffn))
  }
  if (opts.mask !== true) return Buffer.concat([Buffer.from(header), payload])
  const key = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.from(payload.map((b, i) => b ^ key[i % 4]!))
  return Buffer.concat([Buffer.from(header), key, masked])
}

const textFrame = (text: string): Buffer => rawFrame({ opcode: 0x1, payload: text })

function closeFrame(code: number, reason = ''): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason))
  body.writeUInt16BE(code, 0)
  body.write(reason, 2)
  return rawFrame({ opcode: 0x8, payload: body })
}

/** Decodes the masked frames a client sends. Enough for short test frames. */
function readClientFrames(buf: Buffer, into: ReceivedFrame[]): void {
  let offset = 0
  while (offset + 6 <= buf.length) {
    const opcode = buf[offset]! & 0x0f
    let len = buf[offset + 1]! & 0x7f
    let cursor = offset + 2
    if (len === 126) {
      len = buf.readUInt16BE(cursor)
      cursor += 2
    }
    const key = buf.subarray(cursor, cursor + 4)
    cursor += 4
    if (cursor + len > buf.length) return
    const payload = Buffer.from(buf.subarray(cursor, cursor + len).map((b, i) => b ^ key[i % 4]!))
    into.push({ opcode, payload })
    offset = cursor + len
  }
}

export async function wsFixture(
  behaviourOrOptions: WsBehaviour | WsFixtureOptions = 'silent',
): Promise<WsFixture> {
  const opts: WsFixtureOptions =
    typeof behaviourOrOptions === 'string' ? { behaviour: behaviourOrOptions } : behaviourOrOptions
  let connections = 0
  const timers: NodeJS.Timeout[] = []
  const received: ReceivedFrame[] = []
  // Upgraded sockets are detached from the HTTP server, so closeAllConnections()
  // does not reach them and server.close() would wait forever on teardown.
  const sockets = new Set<Duplex>()

  const server: Server = createServer((_req, res) => {
    res.writeHead(426)
    res.end('upgrade required')
  })

  server.on('upgrade', (req, socket: Duplex) => {
    connections++
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // The client under test resets connections on purpose (cancel, window end).
    // Without a listener that reset surfaces as an uncaught exception in the
    // test process and gets blamed on whichever test happens to be running.
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => readClientFrames(chunk, received))

    if (opts.behaviour === 'refuse') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const key = req.headers['sec-websocket-key'] as string
    const accept = opts.badAccept
      ? 'bm90LXRoZS1yaWdodC1hY2NlcHQ='
      : createHash('sha1')
          .update(key + GUID)
          .digest('base64')

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(opts.subprotocol !== undefined ? [`Sec-WebSocket-Protocol: ${opts.subprotocol}`] : []),
        '',
        '',
      ].join('\r\n'),
    )

    opts.script?.(socket)

    switch (opts.behaviour) {
      case 'periodic': {
        let tick = 0
        const t = setInterval(() => {
          if (socket.destroyed) return clearInterval(t)
          socket.write(textFrame(JSON.stringify({ tick: ++tick })))
        }, 100)
        timers.push(t)
        socket.once('close', () => clearInterval(t))
        break
      }
      case 'close-midway': {
        socket.write(textFrame(JSON.stringify({ hello: true })))
        const t = setTimeout(() => {
          if (!socket.destroyed) {
            socket.write(closeFrame(1001, 'going away'))
            socket.end()
          }
        }, 300)
        timers.push(t)
        break
      }
      case 'fragmented': {
        // One message split across a first frame (FIN=0) and a continuation.
        const payload = Buffer.from(JSON.stringify({ reading: 42, unit: 'kW' }))
        const cut = Math.floor(payload.length / 2)
        socket.write(rawFrame({ opcode: 0x1, payload: payload.subarray(0, cut), fin: false }))
        socket.write(rawFrame({ opcode: 0x0, payload: payload.subarray(cut) }))
        break
      }
      case 'echo':
        // Answers every client text frame, so 'out' messages are observable.
        socket.on('data', (chunk: Buffer) => {
          if (chunk.length > 2 && (chunk[0]! & 0x0f) === 0x1) {
            socket.write(textFrame(JSON.stringify({ echoed: true })))
          }
        })
        break
      default:
        break
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    origin: `ws://127.0.0.1:${port}`,
    get connections() {
      return connections
    },
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t)
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
