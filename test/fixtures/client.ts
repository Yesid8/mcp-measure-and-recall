import { PassThrough } from 'node:stream'
import { build, type BuildOptions } from '../../src/server.js'
import { serveStdio } from '../../src/transport/stdio.js'
import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  MetaKeys,
  type JsonRpcResponse,
  type RequestId,
} from '../../src/protocol/jsonrpc.js'

/**
 * A real client speaking the wire format over real streams — not a double.
 *
 * The point of stage A1's exit criteria is that the protocol layer is exercised
 * end to end: JSON serialization, newline framing, the router and the error
 * mapping. Calling ProtocolServer.handle() directly would skip the transport,
 * which is exactly where framing bugs live.
 */
export interface TestClient {
  request(
    method: string,
    params?: Record<string, unknown>,
    meta?: Record<string, unknown> | null,
  ): Promise<JsonRpcResponse>
  notify(method: string, params?: Record<string, unknown>): void
  /** Sends a raw line, for malformed-input tests. */
  raw(line: string): Promise<JsonRpcResponse>
  stderrText(): string
  stdoutLines(): readonly string[]
  /**
   * Resolves once no tools/call is pending. A cancelled call gets no response,
   * so this is how a test learns that the tool actually stopped.
   */
  settled(): Promise<void>
  close(): void
  closeAsync(): Promise<void>
}

export function inProcessClient(opts: BuildOptions = {}): TestClient {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  let stderrBuf = ''
  stderr.on('data', (c: Buffer) => (stderrBuf += c.toString('utf8')))

  const stdoutLines: string[] = []
  const pending = new Map<RequestId, (r: JsonRpcResponse) => void>()
  let nullIdWaiter: ((r: JsonRpcResponse) => void) | null = null

  let buf = ''
  stdout.on('data', (c: Buffer) => {
    buf += c.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim().length === 0) continue
      stdoutLines.push(line)
      const msg = JSON.parse(line) as JsonRpcResponse
      const id = msg.id
      if (id === null || id === undefined) {
        nullIdWaiter?.(msg)
        nullIdWaiter = null
        continue
      }
      const resolve = pending.get(id)
      if (resolve !== undefined) {
        pending.delete(id)
        resolve(msg)
      }
    }
  })

  const built = build({ ...opts, stderr })
  const stop = serveStdio(built.server, { stdin, stdout, stderr })

  let nextId = 1

  const defaultMeta = (): Record<string, unknown> => ({
    [MetaKeys.protocolVersion]: LATEST_PROTOCOL_VERSION,
    [MetaKeys.clientCapabilities]: { tools: {} },
    [MetaKeys.clientInfo]: { name: 'test-client', version: '0.0.1' },
  })

  return {
    request(method, params = {}, meta = undefined) {
      const id = nextId++
      const _meta = meta === null ? undefined : { ...defaultMeta(), ...meta }
      const payload = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method,
        params: { ...params, ...(_meta !== undefined ? { _meta } : undefined) },
      }
      return new Promise<JsonRpcResponse>((resolve) => {
        pending.set(id, resolve)
        stdin.write(JSON.stringify(payload) + '\n')
      })
    },
    notify(method, params = {}) {
      stdin.write(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params }) + '\n')
    },
    raw(line) {
      return new Promise<JsonRpcResponse>((resolve) => {
        nullIdWaiter = resolve
        stdin.write(line + '\n')
      })
    },
    stderrText: () => stderrBuf,
    stdoutLines: () => stdoutLines,
    settled: async () => {
      while (built.server.pendingCalls > 0) await new Promise((r) => setTimeout(r, 2))
    },
    close: () => {
      stop()
      stdin.end()
      // Release the log file handles too; leaving them open is what produced
      // "closing file descriptor on garbage collection" warnings in the suite.
      void built.close()
    },
    closeAsync: async () => {
      stop()
      stdin.end()
      await built.close()
    },
  }
}

export interface ToolCallResult {
  readonly isError: boolean
  readonly resultType: string
  readonly envelope: Record<string, unknown>
  readonly text: string
}

export function readToolResult(res: JsonRpcResponse): ToolCallResult {
  if ('error' in res)
    throw new Error(`expected a tool result, got JSON-RPC error ${res.error.code}`)
  const r = res.result
  const content = r['content'] as Array<{ type: string; text: string }>
  return {
    isError: r['isError'] === true,
    resultType: r['resultType'] as string,
    envelope: r['structuredContent'] as Record<string, unknown>,
    text: content[0]?.text ?? '',
  }
}
