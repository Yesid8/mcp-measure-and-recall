import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { z } from 'zod'
import { httpFixture, type HttpFixture } from '../fixtures/http.js'
import {
  build,
  ProtocolServer,
  SystemClock,
  Ok,
  defineTool,
  ndjsonLog,
  serveStdio,
} from '../../src/index.js'
import { createMeasureHttp } from '../../src/tools/measure-http.js'

/**
 * A server of one's own, built from the exported core rather than build().
 *
 * build() is facts-mcp: its name, its instructions, and a store that writes
 * every observation to disk under an instance lock. A server built on
 * ProtocolServer directly has none of that unless it asks for it — this file
 * is the proof, over the real transport, with the options such a server uses.
 */

let fx: HttpFixture
let dataDir: string
const savedDataDir = process.env['PLINTH_DATA_DIR']

beforeEach(async () => {
  fx = await httpFixture()
  // Where facts-mcp would write if anything reached the store. It must never exist.
  dataDir = join(mkdtempSync(join(tmpdir(), 'plinth-custom-')), 'must-not-exist')
  process.env['PLINTH_DATA_DIR'] = dataDir
})
afterEach(async () => {
  if (savedDataDir === undefined) delete process.env['PLINTH_DATA_DIR']
  else process.env['PLINTH_DATA_DIR'] = savedDataDir
  await fx.close()
})

const lookup = defineTool({
  name: 'lookup',
  title: 'Lookup',
  description: 'Returns the query it was given. Test scaffolding.',
  input: z.object({ q: z.string().describe('What to look up.') }).strict(),
  output: z.object({ echoed: z.string().describe('The query, unchanged.') }).strict(),
  target: (i) => ({ q: i.q }),
  // Marked as recording on purpose: without recordObservation it must still write nothing.
  records: true,
  handler: async (i) => Ok({ echoed: i.q }),
})

/** A stdio connection to the server, speaking the 2025 era the way Claude Code does. */
function connect(server: ProtocolServer) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>()
  let buf = ''
  stdout.on('data', (c: Buffer) => {
    buf += c.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>
      buf = buf.slice(i + 1)
      waiting.get(msg['id'] as number)?.(msg)
    }
  })
  const stop = serveStdio(server, { stdin, stdout, stderr })
  let nextId = 1
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++
      waiting.set(id, resolve)
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { request, stop }
}

describe('a server built directly on ProtocolServer', () => {
  it('serves its own tools, unprefixed and without project, and writes nothing', async () => {
    const server = new ProtocolServer({
      info: { name: 'my-server', version: '1.0.0' },
      instructions: 'Answers lookups.',
      tools: [lookup, createMeasureHttp({ profile: 'loopback' })],
      clock: new SystemClock(),
      log: ndjsonLog(new PassThrough()),
      toolPrefix: '',
      requireProject: false,
    })
    const { request, stop } = connect(server)
    try {
      const init = (await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })) as { result: Record<string, unknown> }
      expect(init.result['serverInfo']).toEqual({ name: 'my-server', version: '1.0.0' })
      expect(init.result['instructions']).toBe('Answers lookups.')

      const list = (await request('tools/list')) as { result: { tools: { name: string }[] } }
      expect(list.result.tools.map((t) => t.name)).toEqual(['lookup', 'measure.http'])

      const looked = (await request('tools/call', {
        name: 'lookup',
        arguments: { q: 'abc' },
      })) as { result: { structuredContent: Record<string, unknown> } }
      expect(looked.result.structuredContent['data']).toEqual({ echoed: 'abc' })
      expect('project' in looked.result.structuredContent).toBe(false)

      // A real measurement, marked as recording, with nowhere to record it.
      const measured = (await request('tools/call', {
        name: 'measure.http',
        arguments: { project: 'ignored', url: `${fx.origin}/ok` },
      })) as { result: { isError: boolean } }
      expect(measured.result.isError).toBe(false)
    } finally {
      stop()
    }

    // Nothing was stored and no instance lock was taken: both live in the data
    // directory, and it was never created.
    expect(existsSync(dataDir)).toBe(false)
  })

  it('differs from build(), which does write — so the check above can fail', async () => {
    const built = build()
    const { request, stop } = connect(built.server)
    try {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
      await request('tools/call', {
        name: 'facts.measure.http',
        arguments: { project: 'p', url: `${fx.origin}/ok` },
      })
    } finally {
      stop()
      await built.close()
    }
    expect(existsSync(dataDir)).toBe(true)
  })
})
