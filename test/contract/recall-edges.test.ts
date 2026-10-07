import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpFixture, type HttpFixture } from '../fixtures/http.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'
import { build } from '../../src/server.js'
import { StoreRegistry } from '../../src/store/store.js'
import { SystemClock } from '../../src/kernel/clock.js'

/** recall.* paths the main suite does not reach, and the server as assembled. */

let fx: HttpFixture
let client: TestClient

beforeEach(async () => {
  fx = await httpFixture()
  client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-recall2-')) })
})
afterEach(async () => {
  await client.closeAsync()
  await fx.close()
})

const call = async (tool: string, args: Record<string, unknown>) =>
  readToolResult(await client.request('tools/call', { name: tool, arguments: args }))
const codeOf = (out: { envelope: Record<string, unknown> }) =>
  (out.envelope['error'] as { code: string } | null)?.code

async function claim(statement: string, extra: Record<string, unknown> = {}) {
  const out = await call('facts.recall.assert', {
    project: 'p',
    statement,
    evidence: [{ type: 'external', description: 'manual' }],
    observed_by: 'tester',
    observed_at: '2026-01-01T00:00:00Z',
    ...extra,
  })
  return (out.envelope['data'] as { claim_id: string }).claim_id
}

describe('retract', () => {
  it('reports a claim that does not exist', async () => {
    const out = await call('facts.recall.retract', {
      project: 'p',
      claim_id: 'c_nope',
      reason: 'r',
      by: 'b',
    })
    expect(codeOf(out)).toBe('CLAIM_NOT_FOUND')
  })

  it('reports a superseding claim that does not exist', async () => {
    const id = await claim('one')
    const out = await call('facts.recall.retract', {
      project: 'p',
      claim_id: id,
      reason: 'r',
      by: 'b',
      superseded_by: 'c_nope',
    })
    expect(codeOf(out)).toBe('CLAIM_NOT_FOUND')
  })

  it('records the superseding claim on the retraction', async () => {
    const old = await claim('old')
    const replacement = await claim('new')
    const out = await call('facts.recall.retract', {
      project: 'p',
      claim_id: old,
      reason: 'replaced',
      by: 'b',
      superseded_by: replacement,
    })
    expect(
      (out.envelope['data'] as { retracted: { superseded_by: string } }).retracted.superseded_by,
    ).toBe(replacement)
  })
})

describe('history', () => {
  it('reports a claim that does not exist', async () => {
    expect(codeOf(await call('facts.recall.history', { project: 'p', claim_id: 'c_nope' }))).toBe(
      'CLAIM_NOT_FOUND',
    )
  })
})

describe('query', () => {
  it('filters by exact author', async () => {
    await claim('by alice', { observed_by: 'alice' })
    await claim('by bob', { observed_by: 'bob' })
    const out = await call('facts.recall.query', { project: 'p', observed_by: 'alice' })
    const claims = (out.envelope['data'] as { claims: { statement: string }[] }).claims
    expect(claims.map((c) => c.statement)).toEqual(['by alice'])
  })

  it('filters by an observation window, inclusive of its bounds', async () => {
    await claim('early', { observed_at: '2026-01-01T00:00:00Z' })
    await claim('late', { observed_at: '2026-06-01T00:00:00Z' })
    const out = await call('facts.recall.query', {
      project: 'p',
      observed_after: '2026-01-01T00:00:00Z',
      observed_before: '2026-02-01T00:00:00Z',
    })
    const claims = (out.envelope['data'] as { claims: { statement: string }[] }).claims
    expect(claims.map((c) => c.statement)).toEqual(['early'])
  })

  it('orders claims with equal times by id, identically on every call', async () => {
    for (const s of ['a', 'b', 'c']) await claim(s)
    const asc = await call('facts.recall.query', { project: 'p', order: 'observed_asc' })
    const desc = await call('facts.recall.query', { project: 'p', order: 'observed_desc' })
    const ids = (out: { envelope: Record<string, unknown> }) =>
      (out.envelope['data'] as { claims: { claim_id: string }[] }).claims.map((c) => c.claim_id)
    expect(ids(asc)).toEqual([...ids(asc)].sort())
    expect(ids(desc)).toEqual([...ids(asc)].reverse())
  })

  it('orders by recording time when asked', async () => {
    await claim('first written', { observed_at: '2026-06-01T00:00:00Z' })
    await claim('second written', { observed_at: '2026-01-01T00:00:00Z' })
    const out = await call('facts.recall.query', { project: 'p', order: 'recorded_asc' })
    const claims = (out.envelope['data'] as { claims: { statement: string }[] }).claims
    expect(claims.map((c) => c.statement)).toEqual(['first written', 'second written'])
  })

  it('keeps ordinary headers in remeasure_with and drops only credentials', async () => {
    const measured = await call('facts.measure.http', {
      project: 'p',
      url: `${fx.origin}/ok`,
      headers: { accept: 'application/json', authorization: 'Bearer secret-value-123' },
    })
    await call('facts.recall.assert', {
      project: 'p',
      statement: 'answered',
      evidence: [{ type: 'observation', observation_id: measured.envelope['observation_id'] }],
      observed_by: 'tester',
    })
    const out = await call('facts.recall.query', { project: 'p' })
    const rm = (
      out.envelope['data'] as { claims: { remeasure_with: { arguments: { headers: unknown } } }[] }
    ).claims[0]!.remeasure_with
    expect(rm.arguments.headers).toEqual({ accept: 'application/json' })
  })

  it('derives observed_at from the oldest cited observation', async () => {
    const first = await call('facts.measure.http', { project: 'p', url: `${fx.origin}/ok` })
    await new Promise((r) => setTimeout(r, 20))
    const second = await call('facts.measure.http', { project: 'p', url: `${fx.origin}/text` })
    const out = await call('facts.recall.assert', {
      project: 'p',
      statement: 'both answered',
      evidence: [
        { type: 'observation', observation_id: second.envelope['observation_id'] },
        { type: 'observation', observation_id: first.envelope['observation_id'] },
      ],
      observed_by: 'tester',
    })
    expect(Date.parse((out.envelope['data'] as { observed_at: string }).observed_at)).toBe(
      Date.parse(first.envelope['observed_at'] as string),
    )
  })
})

describe('pagination', () => {
  const page = async (args: Record<string, unknown>) => {
    const out = await call('facts.recall.query', { project: 'p', order: 'recorded_asc', ...args })
    return out.envelope['data'] as { claims: { statement: string }[]; next_cursor: string | null }
  }

  it('pages through a snapshot: claims written between pages do not shift it', async () => {
    for (const s of ['a', 'b', 'c']) await claim(s)
    const first = await page({ limit: 2 })
    expect(first.claims.map((c) => c.statement)).toEqual(['a', 'b'])

    await claim('written between pages')
    const second = await page({ limit: 2, cursor: first.next_cursor })
    expect(second.claims.map((c) => c.statement)).toEqual(['c'])
    expect(second.next_cursor).toBeNull()
  })

  it('keeps a claim retracted between pages as it stood at the first one', async () => {
    const ids: string[] = []
    for (const s of ['a', 'b', 'c']) ids.push(await claim(s))
    const first = await page({ limit: 2 })

    await call('facts.recall.retract', { project: 'p', claim_id: ids[2], reason: 'r', by: 'b' })
    const second = await page({ limit: 2, cursor: first.next_cursor })
    expect(second.claims.map((c) => c.statement)).toEqual(['c'])

    // A new query, without the cursor, sees the registry as it is now.
    const fresh = await page({ limit: 10 })
    expect(fresh.claims.map((c) => c.statement)).toEqual(['a', 'b'])
  })

  it('refuses a cursor replayed under different filters', async () => {
    for (const s of ['a', 'b']) await claim(s)
    const first = await page({ limit: 1 })
    const out = await call('facts.recall.query', {
      project: 'p',
      order: 'recorded_asc',
      limit: 1,
      text: 'b',
      cursor: first.next_cursor,
    })
    expect(codeOf(out)).toBe('INVALID_INPUT')
  })

  it.each(['12', 'not-base64', Buffer.from('{"v":1,"o":-1,"s":0,"f":"x"}').toString('base64url')])(
    'refuses a cursor it did not issue: %s',
    async (cursor) => {
      expect(codeOf(await call('facts.recall.query', { project: 'p', cursor }))).toBe(
        'INVALID_INPUT',
      )
    },
  )
})

describe('warnings from a damaged log reach every reader', () => {
  it('reaches retract and assert, not only query', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'plinth-damaged-'))
    const own = inProcessClient({ dataDir })
    const run = async (tool: string, args: Record<string, unknown>) =>
      readToolResult(await own.request('tools/call', { name: tool, arguments: args }))
    try {
      const measured = await run('facts.measure.http', { project: 'p', url: `${fx.origin}/ok` })
      const asserted = await run('facts.recall.assert', {
        project: 'p',
        statement: 's',
        evidence: [{ type: 'observation', observation_id: measured.envelope['observation_id'] }],
        observed_by: 'tester',
      })
      const logs = join(dataDir, 'projects', 'p', 'logs')
      appendFileSync(join(logs, 'claims.jsonl'), 'not json\n')
      appendFileSync(join(logs, 'observations.jsonl'), 'not json\n')
      const codes = (out: { envelope: Record<string, unknown> }) =>
        (out.envelope['warnings'] as { code: string }[]).map((w) => w.code)

      const retracted = await run('facts.recall.retract', {
        project: 'p',
        claim_id: (asserted.envelope['data'] as { claim_id: string }).claim_id,
        reason: 'r',
        by: 'b',
      })
      expect(codes(retracted)).toContain('LOG_LINE_UNREADABLE')

      const again = await run('facts.recall.assert', {
        project: 'p',
        statement: 's2',
        evidence: [{ type: 'observation', observation_id: measured.envelope['observation_id'] }],
        observed_by: 'tester',
      })
      expect(codes(again)).toContain('LOG_LINE_UNREADABLE')
    } finally {
      await own.closeAsync()
    }
  })
})

describe('a failed measurement is evidence too', () => {
  it('can be cited, and the claim keeps what failed', async () => {
    const refused = await call('facts.measure.http', {
      project: 'p',
      url: 'http://127.0.0.1:1/',
      timeout_ms: 2_000,
    })
    expect(refused.isError).toBe(true)
    const out = await call('facts.recall.assert', {
      project: 'p',
      statement: 'nothing answers on port 1',
      evidence: [{ type: 'observation', observation_id: refused.envelope['observation_id'] }],
      observed_by: 'tester',
    })
    expect(out.isError, JSON.stringify(out.envelope['error'])).toBe(false)
    const evidence = (out.envelope['data'] as { evidence: { snapshot: { ok: boolean } }[] })
      .evidence
    expect(evidence[0]!.snapshot.ok).toBe(false)
  })

  it('is not recorded when the server refused the call before observing', async () => {
    const denied = await call('facts.measure.http', { project: 'p', url: 'http://8.8.8.8/' })
    expect(codeOf(denied)).toBe('HOST_NOT_ALLOWED')
    const out = await call('facts.recall.assert', {
      project: 'p',
      statement: 'x',
      evidence: [{ type: 'observation', observation_id: denied.envelope['observation_id'] }],
      observed_by: 'tester',
    })
    expect(codeOf(out)).toBe('OBSERVATION_NOT_FOUND')
  })
})

describe('a log written by a newer version', () => {
  it('skips event kinds it does not know, rather than failing the claim', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'plinth-future-'))
    const registry = new StoreRegistry(new SystemClock(), dataDir)
    const store = await registry.get('p')
    if (!store.ok) throw new Error('store did not open')
    await store.value.claims.append('annotate', 'c_orphan', { statement: 'unknown kind' })
    await registry.closeAll()

    const own = inProcessClient({ dataDir })
    try {
      const id = (
        (
          await readToolResult(
            await own.request('tools/call', {
              name: 'facts.recall.assert',
              arguments: {
                project: 'p',
                statement: 'known',
                evidence: [{ type: 'external', description: 'manual' }],
                observed_by: 'tester',
                observed_at: '2026-01-01T00:00:00Z',
              },
            }),
          )
        ).envelope['data'] as { claim_id: string }
      ).claim_id
      const history = async (claim_id: string) =>
        readToolResult(
          await own.request('tools/call', {
            name: 'facts.recall.history',
            arguments: { project: 'p', claim_id },
          }),
        ).envelope['data'] as { events: unknown[]; current: { statement: string } | null }

      // Only an unknown event: the history is shown, but there is no claim to project.
      const orphan = await history('c_orphan')
      expect(orphan.events).toHaveLength(1)
      expect(orphan.current).toBeNull()

      expect((await history(id)).current?.statement).toBe('known')
    } finally {
      await own.closeAsync()
    }
  })
})

describe('the assembled server', () => {
  it('announces the version in package.json', async () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const res = (await client.request('server/discover', {}, null)) as unknown as {
      result: { serverInfo: { version: string } }
    }
    expect(res.result.serverInfo.version).toBe(version)
  })

  it('takes the lock, refuses a second holder, and frees it on close', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'plinth-build-'))
    const first = build({ dataDir })
    expect((await first.lock()).ok).toBe(true)

    const second = build({ dataDir })
    const refused = await second.lock()
    expect(!refused.ok && refused.error.code).toBe('DATA_DIR_IN_USE')

    await first.close()
    expect((await second.lock()).ok).toBe(true)
    await second.close()
  })
})
