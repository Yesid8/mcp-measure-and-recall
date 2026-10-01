import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '../../src/kernel/ulid.js'
import { normalizeProject, normalizeTag } from '../../src/kernel/project.js'
import { isSecretKey, redact } from '../../src/kernel/redact.js'
import { buildEnvelope } from '../../src/kernel/envelope.js'
import { SystemClock } from '../../src/kernel/clock.js'
import { toolError } from '../../src/kernel/result.js'
import { ProtocolServer } from '../../src/protocol/server.js'
import { captureConsole, serveStdio } from '../../src/transport/stdio.js'
import { INVALID_REQUEST, LATEST_PROTOCOL_VERSION, MetaKeys } from '../../src/protocol/jsonrpc.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'
import { defineTool } from '../../src/kernel/tool.js'
import { Err, Ok } from '../../src/kernel/result.js'
import { z } from 'zod'

/**
 * Edge cases that reading the code does not reveal and only running it does:
 * torn writes, split UTF-8, malformed JSON-RPC, id ordering, secret key
 * variants. Each one corrupted or leaked data, or crashed, before it had a test.
 */

let client: TestClient | null = null
afterEach(async () => {
  await client?.closeAsync()
  client = null
})

const META = {
  [MetaKeys.protocolVersion]: LATEST_PROTOCOL_VERSION,
  [MetaKeys.clientCapabilities]: { tools: {} },
}

describe('ULIDs are monotonic', () => {
  it('never sort backwards within one millisecond', () => {
    // Carrying at 256 instead of 32 made 138 of 5000 ids sort before their predecessor.
    const t = 1_700_000_000_000
    let prev = ulid(t)
    for (let i = 0; i < 5000; i++) {
      const next = ulid(t)
      expect(next > prev).toBe(true)
      prev = next
    }
  })

  it('never sort backwards when the wall clock steps back', () => {
    const later = ulid(1_700_000_100_000)
    expect(ulid(1_700_000_099_000) > later).toBe(true)
  })
})

describe('project normalization never yields a name the path layer refuses', () => {
  it.each([
    ['a..b', 'a.b'],
    ['...x...', 'x'],
    ['.hidden', 'hidden'],
    // Accents fold to their base letter instead of becoming a separator.
    ['Verificación Pedidos', 'verificacion-pedidos'],
    ['Almacén Ñandú', 'almacen-nandu'],
  ])('%s normalizes to %s', (raw, expected) => {
    const r = normalizeProject(raw)
    expect(r.ok && r.value).toBe(expected)
  })

  it.each(['.', '..', '...'])('%s is refused as empty', (raw) => {
    const r = normalizeProject(raw)
    expect(r.ok).toBe(false)
  })

  it('reports a bad tag as a bad input, not a bad project', () => {
    const r = normalizeTag('---')
    expect(!r.ok && r.error.code).toBe('INVALID_INPUT')
  })
})

describe('secret keys are recognised by their last segment', () => {
  it.each(['api_key', 'x-csrf-token', 'db_password', 'x-session-token', 'client_secret', 'Cookie'])(
    '%s is secret',
    (key) => expect(isSecretKey(key)).toBe(true),
  )

  it.each(['max_tokens', 'token_count', 'content-type', 'accept', 'secretary'])(
    '%s is data, not a secret',
    (key) => expect(isSecretKey(key)).toBe(false),
  )

  it('redacts an opaque value under a newly covered key', () => {
    expect(JSON.stringify(redact({ api_key: 'opaque-no-pattern-99' }))).not.toContain('opaque')
  })
})

describe('the envelope redacts its error too', () => {
  it('scrubs credentials echoed in an error message and detail', () => {
    const env = buildEnvelope({
      tool: 't',
      project: 'p',
      target: {},
      requestId: 'r',
      startedMonotonic: 0,
      startedAt: new Date(),
      clock: new SystemClock(),
      data: null,
      error: toolError('URL_INVALID', 'not a parseable absolute URL: ht!tp://admin:hunter2@x', {
        detail: { authorization: 'Bearer abcdefghijklmnop' },
      }),
    })
    const out = JSON.stringify(env.error)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('abcdefghijklmnop')
  })
})

describe('the published outputSchema admits error envelopes', () => {
  it('declares data as nullable, without a nested $schema', async () => {
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-hard-')) })
    const res = (await client.request('tools/list')) as unknown as {
      result: { tools: { outputSchema: Record<string, unknown> }[] }
    }
    for (const tool of res.result.tools) {
      const data = (tool.outputSchema['properties'] as Record<string, Record<string, unknown>>)[
        'data'
      ]!
      const branches = data['anyOf'] as Record<string, unknown>[]
      expect(branches.some((b) => b['type'] === 'null')).toBe(true)
      expect(branches.every((b) => !('$schema' in b))).toBe(true)
    }
  })
})

describe('malformed JSON-RPC is answered, never crashes, never loops', () => {
  const server = new ProtocolServer({
    info: { name: 't', version: '0' },
    instructions: '',
    tools: [],
    clock: new SystemClock(),
    log: () => {},
  })

  it.each([
    ['null', null],
    ['a number', 42],
    ['a batch', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]],
    ['no method', { jsonrpc: '2.0', id: 2 }],
    ['a non-string method', { jsonrpc: '2.0', id: 3, method: 7 }],
    ['a null id', { jsonrpc: '2.0', id: null, method: 'tools/list' }],
  ])('%s gets -32600', async (_label, raw) => {
    const res = (await server.handle(raw)) as { error?: { code: number } } | null
    expect(res?.error?.code).toBe(INVALID_REQUEST)
  })

  it('does not answer a response sent by the client', async () => {
    expect(await server.handle({ jsonrpc: '2.0', id: 4, result: {} })).toBeNull()
  })
})

describe('stdio keeps multibyte text intact across chunks', () => {
  it('reassembles a character split between two reads', async () => {
    const seen: unknown[] = []
    const fake = { handle: async (m: unknown) => (seen.push(m), null) } as unknown as ProtocolServer
    const stdin = new PassThrough()
    const stop = serveStdio(fake, { stdin, stdout: new PassThrough(), stderr: new PassThrough() })

    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { s: 'verificación' } }) + '\n',
    )
    const cut = bytes.indexOf(Buffer.from('ó')) + 1 // inside the two-byte ó
    stdin.write(bytes.subarray(0, cut))
    stdin.write(bytes.subarray(cut))
    await new Promise((r) => setTimeout(r, 50))
    stop()

    expect((seen[0] as { params: { s: string } }).params.s).toBe('verificación')
  })
})

describe('console capture never throws and never loses an error', () => {
  it('logs an Error with its message and survives a circular object', () => {
    let out = ''
    const sink = new PassThrough()
    sink.on('data', (c: Buffer) => (out += c.toString()))
    const restore = captureConsole(sink)
    try {
      console.error(new Error('disk full'))
      const circ: Record<string, unknown> = {}
      circ['self'] = circ
      expect(() => console.log(circ)).not.toThrow()
    } finally {
      restore()
    }
    expect(out).toContain('disk full')
  })
})

describe('a measurement that cannot be stored says so', () => {
  it('adds OBSERVATION_NOT_RECORDED instead of failing silently', async () => {
    const probe = defineTool({
      name: 'measure.probe',
      title: 'Probe',
      description: 'Test scaffolding.',
      input: z.object({ project: z.string().describe('p') }).strict(),
      output: z.object({ v: z.number().describe('v') }).strict(),
      target: (i) => ({ project: i.project }),
      handler: async () => Ok({ v: 1 }),
      records: true,
    })
    const server = new ProtocolServer({
      info: { name: 't', version: '0' },
      instructions: '',
      tools: [probe],
      clock: new SystemClock(),
      log: () => {},
      recordObservation: async () => Err(toolError('STORAGE_ERROR', 'disk full')),
    })
    const res = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'facts.measure.probe', arguments: { project: 'p' }, _meta: META },
    })) as unknown as {
      result: { structuredContent: { ok: boolean; warnings: { code: string }[] } }
    }

    // The measurement itself stands; the caller learns its id will not resolve.
    expect(res.result.structuredContent.ok).toBe(true)
    expect(res.result.structuredContent.warnings.map((w) => w.code)).toContain(
      'OBSERVATION_NOT_RECORDED',
    )
  })
})

describe('a torn tail longer than the repair window is still repaired', () => {
  it('keeps the next append readable after a cut-off 200 KB line', async () => {
    const { EventLog } = await import('../../src/store/event-log.js')
    const { appendFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'plinth-tail-'))
    const path = join(dir, 'claims.jsonl')

    const first = new EventLog<{ n: number }>(path, new SystemClock())
    await first.open()
    await first.append('assert', 'c_1', { n: 1 })
    await first.close()

    // A power cut while writing a line bigger than the 64 KB repair window:
    // no newline anywhere in the last window.
    appendFileSync(path, '{"seq":2,"big":"' + 'x'.repeat(200_000))

    const reopened = new EventLog<{ n: number }>(path, new SystemClock())
    await reopened.open()
    await reopened.append('assert', 'c_2', { n: 2 })
    const { events } = await reopened.scan()
    await reopened.close()

    // Left in place, the torn bytes would fuse with the new line into one
    // unreadable line, and the acknowledged c_2 would vanish from every scan.
    expect(events.map((e) => e.key)).toEqual(['c_1', 'c_2'])
    expect(events.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('the server as built honours follow_redirects', () => {
  it('follows a redirect with the default policy, not only with a test one', async () => {
    const { httpFixture } = await import('../fixtures/http.js')
    const fx = await httpFixture()
    try {
      // No tools override: this is the policy `build()` gives the real server.
      client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-redir-')) })
      const out = readToolResult(
        await client.request('tools/call', {
          name: 'facts.measure.http',
          arguments: { project: 'p', url: `${fx.origin}/redirect-local`, follow_redirects: true },
        }),
      )
      expect((out.envelope['data'] as { http_status: number }).http_status).toBe(200)
    } finally {
      await fx.close()
    }
  })
})

describe('recall.query refuses inputs it would otherwise misread', () => {
  const call = async (c: TestClient, args: Record<string, unknown>) =>
    readToolResult(await c.request('tools/call', { name: 'facts.recall.query', arguments: args }))

  it.each([
    ['an unparseable lower bound', { observed_after: 'yesterday' }],
    ['an unparseable upper bound', { observed_before: 'soon' }],
    ['a negative cursor', { cursor: '-5' }],
    ['a non-numeric cursor', { cursor: 'abc' }],
  ])('%s is INVALID_INPUT, not a silently unfiltered page', async (_label, extra) => {
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-hard-')) })
    const out = await call(client, { project: 'p', ...extra })
    expect((out.envelope['error'] as { code: string }).code).toBe('INVALID_INPUT')
  })

  it('finds a tag stored normalized when queried as written', async () => {
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-hard-')) })
    await client.request('tools/call', {
      name: 'facts.recall.assert',
      arguments: {
        project: 'p',
        statement: 'tagged',
        evidence: [{ type: 'external', description: 'manual' }],
        observed_by: 'tester',
        observed_at: new Date().toISOString(),
        tags: ['Orders API'],
      },
    })
    const out = await call(client, { project: 'p', tags: ['Orders API'] })
    expect((out.envelope['data'] as { total_matched: number }).total_matched).toBe(1)
  })
})
