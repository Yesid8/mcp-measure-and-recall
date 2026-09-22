import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreRegistry } from '../../src/store/store.js'
import { SystemClock } from '../../src/kernel/clock.js'
import { redact } from '../../src/kernel/redact.js'

/**
 * Store and redaction internals that the tool-level tests cannot reach.
 */

let dataDir: string
let registry: StoreRegistry | null = null

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'plinth-internals-'))
})
afterEach(async () => {
  await registry?.closeAll()
  registry = null
})

describe('the store registry opens one store per project', () => {
  it('returns the same instance for concurrent first calls', async () => {
    registry = new StoreRegistry(new SystemClock(), dataDir)

    // Two tools/call arriving together on a project not yet open. Opening twice
    // would leave the first pair of file handles unreachable by closeAll(), and
    // give the two EventLogs separate #nextSeq counters.
    const [a, b, c] = await Promise.all([registry.get('p'), registry.get('p'), registry.get('p')])

    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return
    expect(a.value).toBe(b.value)
    expect(b.value).toBe(c.value)
  })

  it('keeps writes on one sequence when callers race to open', async () => {
    registry = new StoreRegistry(new SystemClock(), dataDir)

    const stores = await Promise.all([registry.get('p'), registry.get('p')])
    const [first, second] = stores
    expect(first?.ok && second?.ok).toBe(true)
    if (!first?.ok || !second?.ok) return

    await Promise.all([
      first.value.claims.append('assert', 'c_1', { statement: 'one' }),
      second.value.claims.append('assert', 'c_2', { statement: 'two' }),
    ])

    const { events, warnings } = await first.value.claims.scan()
    expect(events.map((e) => e.seq)).toEqual([1, 2])
    // A divergent counter shows up here as a gap or a repeat.
    expect(warnings).toHaveLength(0)
  })

  it('does not cache a failed open', async () => {
    registry = new StoreRegistry(new SystemClock(), dataDir)

    const bad = await registry.get('../escape')
    expect(bad.ok).toBe(false)

    // A rejected project must not leave a poisoned entry behind.
    const good = await registry.get('fine')
    expect(good.ok).toBe(true)
  })

  it.each(['claims.jsonl', 'observations.jsonl'])(
    'reports STORAGE_ERROR when %s cannot be opened, and recovers once it can',
    async (file) => {
      registry = new StoreRegistry(new SystemClock(), dataDir)
      const blocker = join(dataDir, 'projects', 'p', 'logs', file)
      mkdirSync(blocker, { recursive: true }) // a directory where the log file belongs

      const failed = await registry.get('p')
      expect(!failed.ok && failed.error.code).toBe('STORAGE_ERROR')

      rmSync(blocker, { recursive: true })
      expect((await registry.get('p')).ok).toBe(true)
    },
  )
})

describe('redaction fails closed', () => {
  it('redacts a secret nested below the depth limit', () => {
    // Build a structure deeper than the recursion cap with a token at the bottom.
    let node: Record<string, unknown> = { authorization: 'Bearer deep-nested-secret-value' }
    for (let i = 0; i < 20; i++) node = { nested: node }

    const out = JSON.stringify(redact(node))
    expect(out).not.toContain('deep-nested-secret-value')
  })

  it('redacts a secret at a normal depth', () => {
    const out = JSON.stringify(
      redact({ headers: { authorization: 'Bearer shallow-secret-value' } }),
    )
    expect(out).not.toContain('shallow-secret-value')
  })

  it('redacts an opaque secret held in an array, not just a string', () => {
    // HTTP repeats a header name as an array. An opaque token that matches no
    // pattern would otherwise pass through under a secret key.
    const out = JSON.stringify(redact({ 'x-api-key': ['opaque-token-no-pattern-1234567'] }))
    expect(out).not.toContain('opaque-token-no-pattern-1234567')
    // Non-secret arrays are left intact.
    expect(JSON.stringify(redact({ accept: ['a', 'b'] }))).toContain('"a"')
  })

  it('replaces a non-string value under a secret key wholesale', () => {
    const out = JSON.stringify(redact({ cookie: { session: 'opaque-no-pattern-here' } }))
    expect(out).not.toContain('opaque-no-pattern-here')
  })
})

describe('a claim cannot be retracted twice, even under a race', () => {
  it('writes exactly one retract event for concurrent calls', async () => {
    const { inProcessClient, readToolResult } = await import('../fixtures/client.js')
    const client = inProcessClient({ dataDir })
    try {
      const call = async (tool: string, args: Record<string, unknown>) =>
        readToolResult(await client.request('tools/call', { name: tool, arguments: args }))

      const asserted = await call('facts.recall.assert', {
        project: 'p',
        statement: 'a claim to race on',
        evidence: [{ type: 'external', description: 'manual observation' }],
        observed_by: 'tester',
        observed_at: new Date().toISOString(),
      })
      const claimId = (asserted.envelope['data'] as { claim_id: string }).claim_id

      // Both pass the "already retracted?" check before either writes.
      const results = await Promise.all([
        call('facts.recall.retract', { project: 'p', claim_id: claimId, reason: 'first', by: 'a' }),
        call('facts.recall.retract', {
          project: 'p',
          claim_id: claimId,
          reason: 'second',
          by: 'b',
        }),
      ])

      const succeeded = results.filter((r) => !r.isError)
      expect(succeeded).toHaveLength(1)
      expect(
        results.filter(
          (r) => (r.envelope['error'] as { code?: string })?.code === 'ALREADY_RETRACTED',
        ),
      ).toHaveLength(1)

      const history = await call('facts.recall.history', { project: 'p', claim_id: claimId })
      const ops = (history.envelope['data'] as { events: { op: string }[] }).events.map((e) => e.op)
      expect(ops).toEqual(['assert', 'retract'])
    } finally {
      await client.closeAsync()
    }
  })
})
