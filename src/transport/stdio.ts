import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { INTERNAL_ERROR, PARSE_ERROR, failure } from '../protocol/jsonrpc.js'
import type { ProtocolServer, Session } from '../protocol/server.js'
import { redact, redactText } from '../kernel/redact.js'
import { toIsoWithOffset } from '../kernel/clock.js'

/**
 * stdio transport: the client launches the process.
 *
 * stdout is EXCLUSIVELY the protocol. A console.log anywhere in any dependency
 * corrupts the stream, so on start we replace console.* with the stderr logger.
 */

/** The process streams by default; tests pass in-memory ones. */
export interface StdioOptions {
  readonly stdin?: Readable
  readonly stdout?: Writable
  readonly stderr?: Writable
  /** Called once when stdin ends or closes, so the caller can shut down. */
  readonly onClose?: () => void
}

/**
 * A logger that writes one JSON object per line to `stderr`.
 *
 * It redacts like everything else that leaves the process: a stack trace or a
 * dependency's console output can carry a URL with a token in it, and a log
 * file is read by more people than a tool result.
 */
export function ndjsonLog(stderr: Writable) {
  return (level: string, msg: string, fields?: unknown): void => {
    const entry = { at: new Date().toISOString(), level, msg: redactText(msg) }
    let line: string
    try {
      line = JSON.stringify(
        fields === undefined || fields === null ? entry : { ...entry, fields: redact(fields) },
      )
    } catch {
      // A log call must never be what throws: keep the message, drop the fields.
      line = JSON.stringify({ ...entry, fields: '[unserializable]' })
    }
    stderr.write(line + '\n')
  }
}

/**
 * Renders a console argument without ever throwing.
 *
 * JSON.stringify turns an Error into "{}" — losing the one message worth
 * keeping — and throws on a circular object, which would make a dependency's
 * harmless console.log crash its caller.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Redirects console.* to stderr so a stray log never corrupts the protocol. */
export function captureConsole(stderr: Writable): () => void {
  const log = ndjsonLog(stderr)
  const original = { ...console }
  const forward =
    (level: string) =>
    (...args: unknown[]) =>
      log(level, args.map(describe).join(' '))
  console.log = forward('info')
  console.info = forward('info')
  console.warn = forward('warn')
  console.error = forward('error')
  console.debug = forward('debug')
  return () => Object.assign(console, original)
}

/**
 * Cap on one unterminated message, in UTF-16 code units (the unit a JS string
 * is measured in), so a client that never sends a newline cannot exhaust
 * memory. Buggy is enough; it need not be hostile.
 */
const MAX_LINE_CHARS = 16 * 1024 * 1024

/**
 * N1 has no exceptions: even an error raised before the protocol layer sees
 * the message carries the time. The transport has no injected clock, and an
 * error about framing measures nothing a test would need to control.
 */
function errorTime(): { observed_at: string; age_seconds: number } {
  return { observed_at: toIsoWithOffset(new Date()), age_seconds: 0 }
}

/** The id of a parsed message, when it has a usable one, for error replies. */
function idOf(msg: unknown): string | number | null {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null
  const id = (msg as Record<string, unknown>)['id']
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/**
 * Serves newline-delimited JSON-RPC over stdin/stdout. Returns a function that
 * stops reading; it does not close the streams, which belong to the caller.
 */
export function serveStdio(server: ProtocolServer, opts: StdioOptions = {}): () => void {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const log = ndjsonLog(stderr)

  // Decoding chunk by chunk would split a multibyte character that straddles
  // two chunks into two replacement characters, and a claim written in Spanish
  // would land in the append-only log corrupted for good. The decoder carries
  // the incomplete bytes over to the next chunk.
  const decoder = new StringDecoder('utf8')
  let pending = ''
  // One process, one connection: whatever initialize negotiates holds for it.
  const session: Session = {}

  const send = (payload: unknown): void => {
    stdout.write(JSON.stringify(payload) + '\n')
  }

  const onData = (chunk: Buffer | string): void => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)

    // Complete lines first, so the cap below measures only the one message
    // still arriving — never a burst of valid messages that happen to share it.
    let start = 0
    let idx: number
    while ((idx = pending.indexOf('\n', start)) !== -1) {
      const line = pending.slice(start, idx).trim()
      start = idx + 1
      // Requests are correlated by id, so concurrent handling is correct and
      // keeps one slow call from blocking the rest.
      if (line.length > 0) void handleLine(line)
    }
    pending = pending.slice(start)

    if (pending.length > MAX_LINE_CHARS) {
      pending = ''
      send(
        failure(null, PARSE_ERROR, `a message exceeded ${MAX_LINE_CHARS} characters`, errorTime()),
      )
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      send(failure(null, PARSE_ERROR, 'invalid JSON', errorTime()))
      return
    }
    try {
      const res = await server.handle(msg, session)
      if (res !== null) send(res)
    } catch (e) {
      // handle() validates its input, so reaching this is a bug. The request
      // still gets an answer: a silent one leaves the client waiting forever.
      log('error', 'transport failure', { error: e instanceof Error ? e.stack : String(e) })
      const id = idOf(msg)
      if (id !== null) send(failure(id, INTERNAL_ERROR, 'internal error', errorTime()))
    }
  }

  let closed = false
  const onEnd = (): void => {
    if (closed) return
    closed = true
    opts.onClose?.()
  }

  stdin.on('data', onData)
  stdin.once('end', onEnd)
  stdin.once('close', onEnd)

  return () => {
    stdin.off('data', onData)
    stdin.off('end', onEnd)
    stdin.off('close', onEnd)
  }
}
