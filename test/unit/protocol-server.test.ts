import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ProtocolServer, type ProtocolServerOptions } from '../../src/protocol/server.js'
import { defineTool, type ToolDefinition } from '../../src/kernel/tool.js'
import { Err, Ok, toolError } from '../../src/kernel/result.js'
import { SystemClock } from '../../src/kernel/clock.js'
import { MetaKeys, LATEST_PROTOCOL_VERSION } from '../../src/protocol/jsonrpc.js'

const META = {
  [MetaKeys.protocolVersion]: LATEST_PROTOCOL_VERSION,
  [MetaKeys.clientCapabilities]: { tools: {} },
}

const schema = z.object({ project: z.string().describe('p') }).strict()
const out = z.object({ v: z.number().describe('v') }).strict()

function tool(
  name: string,
  handler: ToolDefinition<{ project: string }, { v: number }>['handler'],
  timeoutMs?: number,
) {
  return defineTool({
    name,
    title: name,
    description: 'Test scaffolding.',
    input: schema,
    output: out,
    target: (i) => ({ project: i.project }),
    handler,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }) as unknown as ToolDefinition<never, never>
}

function server(tools: ToolDefinition<never, never>[], extra: Partial<ProtocolServerOptions> = {}) {
  const logs: { level: string; msg: string }[] = []
  const s = new ProtocolServer({
    info: { name: 't', version: '0' },
    instructions: '',
    tools,
    clock: new SystemClock(),
    log: (level, msg) => logs.push({ level, msg }),
    ...extra,
  })
  return { s, logs }
}

const call = (s: ProtocolServer, name: unknown, args: unknown = { project: 'p' }, id = 1) =>
  s.handle({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args, _meta: META },
  })

type Envelope = { ok: boolean; error: { code: string } | null; warnings: { code: string }[] }
const envelopeOf = (res: unknown) =>
  (res as { result: { structuredContent: Envelope; isError: boolean } }).result

describe('construction', () => {
  it('refuses two tools with the same name', () => {
    const noop = async () => Ok({ v: 1 })
    expect(() => server([tool('x', noop), tool('x', noop)])).toThrow('duplicate tool name')
  })
})

describe('tools/call argument handling', () => {
  const { s } = server([tool('echo', async () => Ok({ v: 1 }))])

  it('refuses a missing or non-string tool name at the protocol level', async () => {
    const res = (await call(s, 42)) as { error: { code: number } }
    expect(res.error.code).toBe(-32602)
  })

  it.each([['not an object'], [[1, 2]], [42]])(
    'refuses arguments %j at the protocol level: CallToolRequest types them as an object',
    async (args) => {
      const res = (await call(s, 'facts.echo', args)) as {
        error: { code: number; data: { observed_at: string } }
      }
      expect(res.error.code).toBe(-32602)
      expect(res.error.data.observed_at).toBeTypeOf('string')
    },
  )

  it('reports arguments that break the tool schema as a tool error the model can fix', async () => {
    const r = envelopeOf(await call(s, 'facts.echo', { project: 'p', extra: 1 }))
    expect(r.isError).toBe(true)
    expect(r.structuredContent.error?.code).toBe('INVALID_INPUT')
  })

  it('reports an unusable project as INVALID_PROJECT', async () => {
    const r = envelopeOf(await call(s, 'facts.echo', { project: '!!!' }))
    expect(r.structuredContent.error?.code).toBe('INVALID_PROJECT')
  })

  it('refuses params that are not an object', async () => {
    const res = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: [1] })) as {
      error: { code: number }
    }
    expect(res.error.code).toBe(-32600)
  })
})

describe('the deadline', () => {
  it('turns a success that arrives after the deadline into TIMEOUT', async () => {
    const { s } = server([
      tool(
        'late',
        async () => {
          await new Promise((r) => setTimeout(r, 60))
          return Ok({ v: 1 })
        },
        20,
      ),
    ])
    const r = envelopeOf(await call(s, 'facts.late'))
    expect(r.structuredContent.error?.code).toBe('TIMEOUT')
  })

  it('reports an abort caused by the deadline as TIMEOUT, not CANCELLED', async () => {
    const { s } = server([
      tool(
        'obedient',
        (_i, ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener('abort', () =>
              resolve(Err(toolError('CANCELLED', 'aborted'))),
            ),
          ),
        20,
      ),
    ])
    const r = envelopeOf(await call(s, 'facts.obedient'))
    expect(r.structuredContent.error?.code).toBe('TIMEOUT')
  })

  it('answers nothing to a request the client cancelled', async () => {
    const { s } = server([
      tool(
        'waits',
        (_i, ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(Ok({ v: 1 }))),
          ),
      ),
    ])
    const pending = call(s, 'facts.waits', { project: 'p' }, 9)
    await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } })
    expect(await pending).toBeNull()
    expect(s.pendingCalls).toBe(0)
  })

  it('stops waiting for a tool that ignores its signal, a grace period after the deadline', async () => {
    const { s } = server([tool('deaf', () => new Promise(() => {}), 20)])
    const started = performance.now()
    const r = envelopeOf(await call(s, 'facts.deaf'))
    expect(r.structuredContent.error?.code).toBe('TIMEOUT')
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('drain', () => {
  it('aborts calls in flight and waits for their answers', async () => {
    const { s } = server([
      tool(
        'waits',
        (_i, ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener('abort', () =>
              resolve(Err(toolError('CANCELLED', 'aborted'))),
            ),
          ),
      ),
    ])
    const pending = call(s, 'facts.waits')
    await s.drain(1_000)
    expect(s.pendingCalls).toBe(0)
    // Not the client's cancellation: the call is still answered.
    expect(envelopeOf(await pending).structuredContent.error?.code).toBe('CANCELLED')
  })

  it('gives up after the grace period', async () => {
    const { s } = server([tool('deaf', () => new Promise(() => {}))])
    void call(s, 'facts.deaf')
    const started = performance.now()
    await s.drain(50)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('returns at once when nothing is in flight', async () => {
    const { s } = server([])
    await s.drain(10_000)
  })
})

describe('notifications', () => {
  const { s } = server([])

  it('ignores a cancellation with no usable id', async () => {
    expect(
      await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }),
    ).toBeNull()
  })

  it('ignores a cancellation for a request that is not running', async () => {
    expect(
      await s.handle({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'unknown' },
      }),
    ).toBeNull()
  })

  it('ignores notifications it does not know', async () => {
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/whatever' })).toBeNull()
  })
})

describe('recording observations', () => {
  const measure = tool('measure.x', async () => Ok({ v: 1 }))

  it('warns, and logs, when recording throws', async () => {
    const { s, logs } = server([measure], {
      recordObservation: async () => {
        throw new Error('disk gone')
      },
    })
    const r = envelopeOf(await call(s, 'facts.measure.x'))
    expect(r.structuredContent.ok).toBe(true)
    expect(r.structuredContent.warnings.map((w) => w.code)).toContain('OBSERVATION_NOT_RECORDED')
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('recordObservation'))).toBe(true)
  })

  it('records only measurements, not reads of the registry', async () => {
    const recorded: string[] = []
    const { s } = server([measure, tool('recall.y', async () => Ok({ v: 1 }))], {
      recordObservation: async (e) => (recorded.push(e.tool), Ok(undefined)),
    })
    await call(s, 'facts.measure.x')
    await call(s, 'facts.recall.y')
    expect(recorded).toEqual(['facts.measure.x'])
  })

  it('records a measurement that failed at the destination: that is a fact too', async () => {
    const recorded: boolean[] = []
    const { s } = server(
      [tool('measure.z', async () => Err(toolError('CONNECTION_REFUSED', 'nobody home')))],
      { recordObservation: async (e) => (recorded.push(e.ok), Ok(undefined)) },
    )
    await call(s, 'facts.measure.z')
    expect(recorded).toEqual([false])
  })

  it.each(['HOST_NOT_ALLOWED', 'URL_INVALID', 'INVALID_INPUT'])(
    'records nothing when the call was refused before observing (%s)',
    async (code) => {
      const recorded: string[] = []
      const { s } = server([tool('measure.z', async () => Err(toolError(code, 'refused')))], {
        recordObservation: async (e) => (recorded.push(e.tool), Ok(undefined)),
      })
      await call(s, 'facts.measure.z')
      expect(recorded).toEqual([])
    },
  )
})

describe('server/discover', () => {
  it('announces only the capabilities it implements', async () => {
    const { s } = server([])
    const res = (await s.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
    })) as unknown as {
      result: { capabilities: Record<string, unknown>; ttlMs: number; cacheScope: string }
    }
    expect(Object.keys(res.result.capabilities).sort()).toEqual(['extensions', 'tools'])
    expect(res.result.ttlMs).toBe(300_000)
    expect(res.result.cacheScope).toBe('private')
  })
})
