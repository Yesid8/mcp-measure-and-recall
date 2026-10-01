import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ProtocolServer, SystemClock, Ok, defineTool, ndjsonLog } from '../../src/index.js'

/**
 * The example in docs/USO.md, "Construir un servidor propio", as code that must
 * compile and run. Only the import path differs, and serveStdio is left out: it
 * would take over this process's stdin. If this file needs changing, so does
 * the document.
 */

const salud = defineTool({
  name: 'salud',
  title: 'Estado del servicio',
  description: 'Devuelve el estado del servicio tal como lo informa. No lo valora.',
  input: z.object({}).strict(),
  output: z.object({ estado: z.string().describe('Tal como lo informa el servicio.') }).strict(),
  target: () => ({}),
  handler: async () => Ok({ estado: 'ok' }),
})

const server = new ProtocolServer({
  info: { name: 'mi-servidor', version: '1.0.0' },
  instructions: 'Qué hace este servidor, para el modelo que lo lee.',
  tools: [salud],
  clock: new SystemClock(),
  log: ndjsonLog(process.stderr),
  toolPrefix: 'planner',
  requireProject: false,
})

describe('the USO.md example', () => {
  it('builds, and answers a 2025-era client as documented', async () => {
    const session = {}
    await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      session,
    )
    const res = (await server.handle(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'planner.salud' } },
      session,
    )) as unknown as { result: { structuredContent: { data: unknown } } }
    expect(res.result.structuredContent.data).toEqual({ estado: 'ok' })
  })
})
