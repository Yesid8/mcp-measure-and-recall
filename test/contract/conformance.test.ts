import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpFixture, type HttpFixture } from '../fixtures/http.js'
import { wsFixture } from '../fixtures/ws.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'
import { createMeasureHttp } from '../../src/tools/measure-http.js'
import { createMeasureWs } from '../../src/tools/measure-ws.js'
import {
  createRecallAssert,
  createRecallHistory,
  createRecallQuery,
  createRecallRetract,
} from '../../src/tools/recall.js'
import { StoreRegistry } from '../../src/store/store.js'
import { SystemClock } from '../../src/kernel/clock.js'
import { ErrorCodes } from '../../src/kernel/result.js'
import type { NetPolicy } from '../../src/policy/net.js'

/**
 * The checks of 07-conformidad that are mechanical, run as ordinary tests.
 * Numbers refer to that document. A check that lives only in prose is a
 * promise nobody keeps; these fail the build instead.
 */

let fx: HttpFixture
let client: TestClient
let dataDir: string

beforeEach(async () => {
  fx = await httpFixture()
  dataDir = mkdtempSync(join(tmpdir(), 'plinth-conform-'))
  client = inProcessClient({ dataDir })
})
afterEach(async () => {
  await client.closeAsync()
  await fx.close()
})

const call = async (c: TestClient, tool: string, args: Record<string, unknown>) =>
  readToolResult(await c.request('tools/call', { name: tool, arguments: args }))

type Json = Record<string, unknown>

async function listedTools(): Promise<Json[]> {
  const res = (await client.request('tools/list')) as unknown as { result: { tools: Json[] } }
  return res.result.tools
}

/** Every property of a JSON Schema, through nesting, arrays, unions and $defs. */
function* properties(
  schema: unknown,
  path = '',
): Generator<{ path: string; key: string; node: Json }> {
  if (schema === null || typeof schema !== 'object') return
  const s = schema as Json
  for (const [key, node] of Object.entries((s['properties'] ?? {}) as Json)) {
    yield { path: `${path}.${key}`, key, node: node as Json }
    yield* properties(node, `${path}.${key}`)
  }
  for (const nested of ['items', 'additionalProperties']) yield* properties(s[nested], `${path}[]`)
  for (const branch of ['anyOf', 'oneOf', 'allOf']) {
    for (const b of (s[branch] ?? []) as unknown[]) yield* properties(b, path)
  }
  for (const [name, def] of Object.entries((s['$defs'] ?? {}) as Json)) {
    yield* properties(def, `${path}$defs.${name}`)
  }
}

describe('schemas', () => {
  it('#29 describes every field of every input and output schema', async () => {
    const missing: string[] = []
    let seen = 0
    for (const tool of await listedTools()) {
      for (const which of ['inputSchema', 'outputSchema']) {
        for (const p of properties(tool[which])) {
          seen++
          const d = p.node['description']
          if (typeof d !== 'string' || d.length === 0)
            missing.push(`${String(tool['name'])} ${which}${p.path}`)
        }
      }
    }
    // A walker that found nothing would pass vacuously.
    expect(seen).toBeGreaterThan(150)
    expect(missing).toEqual([])
  })

  it('#50 has no judgement key in any output schema', async () => {
    const JUDGEMENT =
      /^(health|healthy|score|rating|grade|severity|priority|passed|failed|success|recommendation|suggestion|advice|summary|conclusion|verdict|quality|risk|impact|degraded|critical|warning_level|confidence)$|^(is|should|can)_/
    const STATUS_ALLOWED = new Set(['http_status', 'status_text', 'status_code'])
    const found: string[] = []
    for (const tool of await listedTools()) {
      for (const p of properties(tool['outputSchema'])) {
        const key = p.key.toLowerCase()
        if (JUDGEMENT.test(key) || (key.includes('status') && !STATUS_ALLOWED.has(key))) {
          found.push(`${String(tool['name'])}${p.path}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  it('#54 has no assessing verb in any tool description', async () => {
    const ASSESSING = /checks whether|validates that|ensures|verifies that/i
    const offending = (await listedTools()).filter((t) => ASSESSING.test(String(t['description'])))
    expect(offending.map((t) => t['name'])).toEqual([])
  })
})

describe('#41 the source knows no particular application', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : []
    })

  it('holds no host:port or API route', () => {
    const DOMAIN = /\b(localhost|127\.0\.0\.1):\d+|["'`]\/api\//i
    expect(DOMAIN.test("fetch('http://localhost:3000/x')")).toBe(true)
    const sources = files('src')
    expect(sources.length).toBeGreaterThan(10)
    expect(sources.filter((f) => DOMAIN.test(readFileSync(f, 'utf8')))).toEqual([])
  })
})

describe('error codes come from one table', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : []
    })
  const code = sources('src')
    .filter((f) => !f.endsWith(join('kernel', 'result.ts')))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

  it('raises no code written by hand', () => {
    expect(code).not.toMatch(/toolError\(\s*['"`]/)
  })

  it('lists no code that nothing raises', () => {
    const unused = Object.keys(ErrorCodes).filter(
      (k) => !new RegExp(`ErrorCodes\\.${k}\\b|CoreErrors\\.${k}\\b`).test(code),
    )
    expect(unused).toEqual([])
  })
})

describe('#10 a deny-all server opens no socket', () => {
  const measureBoth = async (c: TestClient) => {
    await call(c, 'facts.measure.http', { project: 'p', url: `${fx.origin}/ok` })
    await call(c, 'facts.measure.ws', {
      project: 'p',
      url: `ws://127.0.0.1:1/`,
      listen_seconds: 0.1,
    })
  }

  it('counts zero connects under deny-all, and some under loopback', async () => {
    const denied = inProcessClient({
      dataDir: mkdtempSync(join(tmpdir(), 'plinth-deny-')),
      policy: { profile: 'deny-all' },
    })
    const connect = vi.spyOn(Socket.prototype, 'connect')
    try {
      await measureBoth(denied)
      expect(connect).not.toHaveBeenCalled()
      // The positive control: the same calls under loopback do connect, so a
      // zero above means the policy held, not that the spy saw nothing.
      await measureBoth(client)
      expect(connect).toHaveBeenCalled()
    } finally {
      connect.mockRestore()
      await denied.closeAsync()
    }
  })
})

describe('#27 #28 no secret reaches disk or the log', () => {
  const allFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? allFiles(full) : [full]
    })

  it('redacts every secret a caller can pass, in every file and every log line', async () => {
    const origin = new URL(fx.origin)
    const measured = await call(client, 'facts.measure.http', {
      project: 'p',
      url: `http://alice:sekret-userinfo-1@${origin.host}/echo-auth?token=sekret-query-2&x=1`,
      headers: { authorization: 'Bearer sekret-header-3', accept: 'application/json' },
    })
    const asserted = await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'it answered to Bearer sekret-statement-4',
      evidence: [
        { type: 'observation', observation_id: measured.envelope['observation_id'] },
        {
          type: 'external',
          description: 'a note',
          uri: 'https://example.test/?api_key=sekret-uri-5',
        },
      ],
      observed_by: 'tester',
      observed_at: '2026-01-01T00:00:00Z',
    })
    const claimId = (asserted.envelope['data'] as { claim_id: string }).claim_id
    await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: claimId,
      reason: 'rotated Bearer sekret-reason-6',
      by: 'tester',
    })

    const leaks = allFiles(dataDir).filter((f) => readFileSync(f, 'utf8').includes('sekret-'))
    expect(leaks).toEqual([])
    expect(client.stderrText()).not.toContain('sekret-')
  })
})

describe('#46 remeasure_with is a call that works', () => {
  it('replays as a valid call, leaving out and naming what was redacted', async () => {
    const origin = new URL(fx.origin)
    const measured = await call(client, 'facts.measure.http', {
      project: 'p',
      url: `http://alice:pw-123456@${origin.host}/ok?token=abc123&x=1`,
      headers: { authorization: 'Bearer abcdefghijk', accept: 'application/json' },
    })
    await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'answered',
      evidence: [{ type: 'observation', observation_id: measured.envelope['observation_id'] }],
      observed_by: 'tester',
    })
    const query = await call(client, 'facts.recall.query', { project: 'p' })
    const rm = (
      query.envelope['data'] as {
        claims: { remeasure_with: { tool: string; arguments: Json; omitted: string[] } }[]
      }
    ).claims[0]!.remeasure_with

    expect(rm.omitted.sort()).toEqual(['headers.authorization', 'url.query.token', 'url.userinfo'])
    expect(rm.arguments['url']).toBe(`${fx.origin}/ok?x=1`)
    expect(JSON.stringify(rm.arguments)).not.toContain('redacted')

    const replay = await call(client, rm.tool, rm.arguments)
    expect(replay.isError, JSON.stringify(replay.envelope['error'])).toBe(false)
  })
})

describe('every tool returns data its own output schema accepts', () => {
  const policy: NetPolicy = { profile: 'loopback' }
  const registry = new StoreRegistry(new SystemClock(), mkdtempSync(join(tmpdir(), 'plinth-x-')))
  const schemas = {
    'facts.measure.http': createMeasureHttp(policy).output,
    'facts.measure.ws': createMeasureWs(policy).output,
    'facts.recall.assert': createRecallAssert(registry).output,
    'facts.recall.retract': createRecallRetract(registry).output,
    'facts.recall.query': createRecallQuery(registry).output,
    'facts.recall.history': createRecallHistory(registry).output,
  }
  const check = (tool: keyof typeof schemas, out: { envelope: Json }) => {
    const parsed = schemas[tool].safeParse(out.envelope['data'])
    expect(parsed.success, `${tool}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
  }

  it('holds for all six tools', async () => {
    const ws = await wsFixture('periodic')
    try {
      const http = await call(client, 'facts.measure.http', {
        project: 'p',
        url: `${fx.origin}/ok`,
      })
      check('facts.measure.http', http)
      check(
        'facts.measure.ws',
        await call(client, 'facts.measure.ws', {
          project: 'p',
          url: `${ws.origin}/feed`,
          listen_seconds: 0.3,
        }),
      )
      const asserted = await call(client, 'facts.recall.assert', {
        project: 'p',
        statement: 's',
        evidence: [{ type: 'observation', observation_id: http.envelope['observation_id'] }],
        observed_by: 'tester',
      })
      check('facts.recall.assert', asserted)
      const id = (asserted.envelope['data'] as { claim_id: string }).claim_id
      check(
        'facts.recall.query',
        await call(client, 'facts.recall.query', { project: 'p', evidence: 'full' }),
      )
      check(
        'facts.recall.retract',
        await call(client, 'facts.recall.retract', {
          project: 'p',
          claim_id: id,
          reason: 'r',
          by: 'b',
        }),
      )
      check(
        'facts.recall.history',
        await call(client, 'facts.recall.history', { project: 'p', claim_id: id }),
      )
    } finally {
      await ws.close()
      await registry.closeAll()
    }
  })
})
