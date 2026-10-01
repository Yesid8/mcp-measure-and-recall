import { afterEach, describe, expect, it } from 'vitest'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  MetaKeys,
  UNSUPPORTED_PROTOCOL_VERSION,
} from '../../src/protocol/jsonrpc.js'
import { defineTool } from '../../src/kernel/tool.js'
import { z } from 'zod'
import { Ok } from '../../src/kernel/result.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The contract of the protocol layer — 03-protocolo §8, the checks that apply
 * to stdio. When the next revision of the protocol lands, this is the first
 * place to look.
 */

let client: TestClient | null = null
afterEach(() => {
  client?.close()
  client = null
})

function errorOf(res: unknown): { code: number; message: string; data?: unknown } {
  const r = res as { error?: { code: number; message: string; data?: unknown } }
  if (r.error === undefined) throw new Error('expected a JSON-RPC error')
  return r.error
}

function resultOf(res: unknown): Record<string, unknown> {
  const r = res as { result?: Record<string, unknown> }
  if (r.result === undefined) throw new Error(`expected a result, got ${JSON.stringify(res)}`)
  return r.result
}

describe('§8.1 server/discover answers without I/O and without _meta', () => {
  it('responds with the supported versions and server identity', async () => {
    client = inProcessClient()
    const started = performance.now()
    // No _meta at all: it is the compatibility probe and may be called first.
    const res = await client.request('server/discover', {}, null)
    const elapsed = performance.now() - started
    const r = resultOf(res)

    expect(r['resultType']).toBe('complete')
    expect(r['protocolVersions']).toEqual([LATEST_PROTOCOL_VERSION])
    expect(r['serverInfo']).toMatchObject({ name: 'facts-mcp' })
    expect(r['capabilities']).toBeTypeOf('object')
    expect(typeof r['instructions']).toBe('string')
    expect(elapsed).toBeLessThan(100)
  })
})

describe('§8.2 a request without protocolVersion is malformed', () => {
  it('returns -32602 naming the missing field', async () => {
    client = inProcessClient()
    const res = await client.request('tools/list', {}, null)
    const err = errorOf(res)
    expect(err.code).toBe(INVALID_PARAMS)
    expect(err.message).toContain(MetaKeys.protocolVersion)
  })
})

describe('§8.3 an older revision is refused with the supported list', () => {
  it('returns -32022 with data.supported', async () => {
    client = inProcessClient()
    const res = await client.request(
      'tools/list',
      {},
      {
        [MetaKeys.protocolVersion]: '2025-11-25',
      },
    )
    const err = errorOf(res)
    expect(err.code).toBe(UNSUPPORTED_PROTOCOL_VERSION)
    expect((err.data as { supported: string[] }).supported).toEqual([LATEST_PROTOCOL_VERSION])
  })
})

describe('§8.4 a 2025-era client opens a session with initialize (ADR-0004)', () => {
  it('negotiates, then lists and calls over the same connection without _meta', async () => {
    client = inProcessClient()
    const init = resultOf(
      await client.request(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '1' },
        },
        null,
      ),
    )
    expect(init['protocolVersion']).toBe('2025-06-18')
    expect(init['instructions']).toContain('never judges')
    client.notify('notifications/initialized')

    const list = resultOf(await client.request('tools/list', {}, null))
    expect((list['tools'] as { name: string }[]).length).toBe(6)

    const out = readToolResult(
      await client.request(
        'tools/call',
        { name: 'facts.recall.query', arguments: { project: 'p' } },
        null,
      ),
    )
    expect(out.isError).toBe(false)
    expect((out.envelope['data'] as { total_matched: number }).total_matched).toBe(0)
  })

  it('keeps 2026-07-28 working on a fresh connection, with no initialize', async () => {
    client = inProcessClient()
    const err = errorOf(await client.request('tools/list', {}, null))
    expect(err.code).toBe(-32602)
    expect(resultOf(await client.request('tools/list'))['resultType']).toBe('complete')
  })
})

describe('§8.5 cacheable results carry caching hints (SEP-2549)', () => {
  /**
   * The spec requires hints on EVERY resultType:"complete" result from
   * server/discover, tools/list, prompts/list, resources/list,
   * resources/templates/list and resources/read. We serve the first two.
   */
  it.each(['server/discover', 'tools/list'])('%s carries ttlMs and cacheScope', async (method) => {
    client = inProcessClient()
    // discover is the compatibility probe and takes no _meta.
    const r = resultOf(
      await client.request(method, {}, method === 'server/discover' ? null : undefined),
    )

    expect(r['resultType']).toBe('complete')
    expect(typeof r['ttlMs']).toBe('number')
    // ttlMs is an integer >= 0. Zero would mean "immediately stale", never "no expiry".
    expect(Number.isInteger(r['ttlMs'])).toBe(true)
    expect(r['ttlMs'] as number).toBeGreaterThanOrEqual(0)
    expect(['private', 'public']).toContain(r['cacheScope'])
  })

  it('serves private, because the tool set can vary with authorization', async () => {
    client = inProcessClient()
    // "public" may be shared across authorization contexts, so it would be
    // wrong here: it is not an access control, it is a claim about ownership.
    for (const method of ['server/discover', 'tools/list']) {
      const r = resultOf(
        await client.request(method, {}, method === 'server/discover' ? null : undefined),
      )
      expect(r['cacheScope']).toBe('private')
    }
  })

  it('does not put caching hints on a tools/call result', async () => {
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-cache-')) })
    const r = resultOf(
      await client.request('tools/call', {
        name: 'facts.recall.query',
        arguments: { project: 'p' },
      }),
    )
    // tools/call is not in the normative list; hinting it would invite a client
    // to cache an observation, which is the one thing this server must not allow.
    expect(r['ttlMs']).toBeUndefined()
    expect(r['cacheScope']).toBeUndefined()
  })

  it('returns the same order every time, with ttlMs and cacheScope', async () => {
    client = inProcessClient()
    const first = resultOf(await client.request('tools/list'))
    expect(first['ttlMs']).toBe(300_000)
    expect(first['cacheScope']).toBe('private')

    const names = (first['tools'] as Array<{ name: string }>).map((t) => t.name)
    for (let i = 0; i < 25; i++) {
      const again = resultOf(await client.request('tools/list'))
      expect((again['tools'] as Array<{ name: string }>).map((t) => t.name)).toEqual(names)
    }
    expect([...names].sort()).toEqual(names)
  })

  it('publishes an outputSchema describing the whole envelope', async () => {
    client = inProcessClient()
    const r = resultOf(await client.request('tools/list'))
    const tool = (r['tools'] as Array<Record<string, unknown>>)[0]!
    const out = tool['outputSchema'] as { required: string[] }
    expect(out.required).toContain('observed_at')
    expect(out.required).toContain('age_seconds')
    expect(out.required).toContain('ok')
    expect(out.required).toContain('data')
  })
})

describe('a published inputSchema describes what a caller may send', () => {
  const received: unknown[] = []
  const plan = defineTool({
    name: 'plan',
    title: 'Plan',
    description: 'Echoes the arguments as parsed. Test scaffolding.',
    input: z
      .object({
        project: z.string().describe('project'),
        name: z.string().describe('Required: no default.'),
        modules: z.array(z.string()).default([]).describe('Defaulted at the top level.'),
        items: z
          .array(
            z.object({
              title: z.string().describe('Required inside each item.'),
              priority: z.number().default(3).describe('Defaulted inside each item.'),
            }),
          )
          .describe('Defaults nested in an array of objects.'),
      })
      .strict(),
    output: z.object({ ok: z.boolean().describe('always true') }).strict(),
    target: (i) => ({ project: i.project }),
    handler: async (i) => (received.push(i), Ok({ ok: true })),
  })

  it('lists a field with a default as optional, at any depth', async () => {
    client = inProcessClient({ tools: [plan] })
    const tools = resultOf(await client.request('tools/list'))['tools'] as {
      inputSchema: {
        required: string[]
        properties: { items: { items: { required: string[] } } }
      }
    }[]
    const schema = tools[0]!.inputSchema
    expect(schema.required.sort()).toEqual(['items', 'name', 'project'])
    expect(schema.properties.items.items.required).toEqual(['title'])
  })

  it('accepts a call without them and hands the tool the defaults', async () => {
    client = inProcessClient({ tools: [plan] })
    const out = readToolResult(
      await client.request('tools/call', {
        name: 'facts.plan',
        arguments: { project: 'p', name: 'n', items: [{ title: 't' }] },
      }),
    )
    expect(out.isError, JSON.stringify(out.envelope['error'])).toBe(false)
    expect(received.at(-1)).toEqual({
      project: 'p',
      name: 'n',
      modules: [],
      items: [{ title: 't', priority: 3 }],
    })
  })
})

describe('§8.10 cancellation aborts the in-flight call', () => {
  it('stops the tool within 100 ms and sends nothing more for that request', async () => {
    let cancelledAt = 0
    let stoppedAt = 0
    const slow = defineTool({
      name: 'slow',
      title: 'Slow',
      description: 'Sleeps until cancelled. Test scaffolding.',
      input: z.object({ project: z.string().describe('project') }).strict(),
      output: z.object({ done: z.boolean().describe('whether it finished') }).strict(),
      target: (i) => ({ project: i.project }),
      handler: async (_i, ctx) => {
        try {
          await ctx.clock.sleep(5_000, ctx.signal)
        } catch {
          /* aborted */
        }
        stoppedAt = performance.now()
        return Ok({ done: !ctx.signal.aborted })
      },
    })
    client = inProcessClient({ tools: [slow] })

    void client.request('tools/call', { name: 'facts.slow', arguments: { project: 'p' } })
    await new Promise((r) => setTimeout(r, 50))
    cancelledAt = performance.now()
    client.notify('notifications/cancelled', { requestId: 1 })
    await client.settled()
    await new Promise((r) => setTimeout(r, 20)) // room for a stray response to show up

    expect(stoppedAt - cancelledAt).toBeLessThan(100)
    expect(client.stdoutLines()).toEqual([])
  })
})

describe('§8.11 a throw becomes -32603 with no trace leaked', () => {
  it('logs the stack to stderr but never sends it to the client', async () => {
    const boom = defineTool({
      name: 'boom',
      title: 'Boom',
      description: 'Throws. Test scaffolding.',
      input: z.object({ project: z.string().describe('project') }).strict(),
      output: z.object({ never: z.boolean().describe('unreachable') }).strict(),
      target: (i) => ({ project: i.project }),
      handler: async () => {
        throw new Error('SECRET_STACK_MARKER')
      },
    })
    client = inProcessClient({ tools: [boom] })

    const res = await client.request('tools/call', {
      name: 'facts.boom',
      arguments: { project: 'p' },
    })
    const err = errorOf(res)

    expect(err.code).toBe(INTERNAL_ERROR)
    expect(JSON.stringify(err)).not.toContain('SECRET_STACK_MARKER')
    expect(client.stderrText()).toContain('SECRET_STACK_MARKER')
  })
})

describe('§8.12 invalid arguments are a tool error, not a JSON-RPC error', () => {
  it('returns isError:true with zod detail the model can act on', async () => {
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-test-')) })
    const res = await client.request('tools/call', {
      name: 'facts.recall.query',
      arguments: { project: 42 },
    })
    const out = readToolResult(res)

    expect(out.isError).toBe(true)
    expect(out.resultType).toBe('complete')
    const error = out.envelope['error'] as { code: string; detail: { issues: unknown[] } }
    expect(error.code).toBe('INVALID_INPUT')
    expect(error.detail.issues.length).toBeGreaterThan(0)
  })

  it('rejects unknown arguments rather than ignoring them', async () => {
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-test-')) })
    const res = await client.request('tools/call', {
      name: 'facts.recall.query',
      arguments: { project: 'p', surprise: true },
    })
    expect(readToolResult(res).isError).toBe(true)
  })
})

describe('protocol housekeeping', () => {
  it('missing clientCapabilities returns -32021 with the required list', async () => {
    client = inProcessClient()
    const res = await client.request(
      'tools/list',
      {},
      {
        [MetaKeys.protocolVersion]: LATEST_PROTOCOL_VERSION,
        [MetaKeys.clientCapabilities]: undefined,
      },
    )
    const err = errorOf(res)
    expect(err.code).toBe(MISSING_REQUIRED_CLIENT_CAPABILITY)
    expect((err.data as { requiredCapabilities: string[] }).requiredCapabilities).toContain('tools')
  })

  it('an unimplemented method returns -32601', async () => {
    client = inProcessClient()
    const err = errorOf(await client.request('prompts/list'))
    expect(err.code).toBe(METHOD_NOT_FOUND)
  })

  it('an unknown tool is refused as invalid params', async () => {
    client = inProcessClient()
    const err = errorOf(await client.request('tools/call', { name: 'facts.nope', arguments: {} }))
    expect(err.code).toBe(INVALID_PARAMS)
  })

  it('malformed JSON returns a parse error without killing the transport', async () => {
    client = inProcessClient()
    const err = errorOf(await client.raw('{not json'))
    expect(err.code).toBe(-32700)
    // The transport survives: the next request still works.
    expect(resultOf(await client.request('tools/list'))['tools']).toBeDefined()
  })

  it('a notification produces no response at all', async () => {
    client = inProcessClient()
    client.notify('notifications/cancelled', { requestId: 999 })
    await client.request('tools/list')
    const ids = client.stdoutLines().map((l) => (JSON.parse(l) as { id?: unknown }).id)
    expect(ids.filter((id) => id === undefined)).toHaveLength(0)
  })

  it('every error response carries the time (N1 has no exceptions)', async () => {
    client = inProcessClient()
    const err = errorOf(await client.request('prompts/list'))
    const data = err.data as { observed_at: string; age_seconds: number }
    expect(typeof data.observed_at).toBe('string')
    expect(Number.isFinite(data.age_seconds)).toBe(true)
  })

  it('stdout carries protocol only, never log output', async () => {
    client = inProcessClient()
    await client.request('tools/list')
    for (const line of client.stdoutLines()) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
