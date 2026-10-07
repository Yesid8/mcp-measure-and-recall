import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Socket } from 'node:net'
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpFixture, type HttpFixture } from '../fixtures/http.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'
import { FakeClock } from '../fixtures/clock.js'

/**
 * Stage A3 exit criteria: the append-only log and the recall.* family.
 *
 * The last three of this file are the ones that cannot fail: age per claim,
 * a clock that jumps backwards, and isolation between projects.
 */

let fx: HttpFixture
let client: TestClient | null = null
let dataDir: string

beforeEach(async () => {
  fx = await httpFixture()
  dataDir = mkdtempSync(join(tmpdir(), 'plinth-recall-'))
})
afterEach(async () => {
  await client?.closeAsync()
  client = null
  await fx.close()
})

function open(extra: { clock?: FakeClock } = {}): TestClient {
  return inProcessClient({ dataDir, ...(extra.clock !== undefined ? { clock: extra.clock } : {}) })
}

async function call(c: TestClient, tool: string, args: Record<string, unknown>) {
  return readToolResult(await c.request('tools/call', { name: tool, arguments: args }))
}

async function measureOk(c: TestClient, project: string, path = '/ok') {
  const out = await call(c, 'facts.measure.http', { project, url: `${fx.origin}${path}` })
  expect(out.isError, JSON.stringify(out.envelope['error'])).toBe(false)
  return out.envelope['observation_id'] as string
}

/** Asserts a claim citing one observation, and returns its id. */
async function assertCiting(c: TestClient, observationId: string, statement = 'a claim') {
  const out = await call(c, 'facts.recall.assert', {
    project: 'p',
    statement,
    evidence: [{ type: 'observation', observation_id: observationId }],
    observed_by: 'test-agent',
  })
  return (out.envelope['data'] as { claim_id: string }).claim_id
}

const claimsPath = (project: string) => join(dataDir, 'projects', project, 'logs', 'claims.jsonl')

describe('a claim needs evidence and an author', () => {
  it('records a claim citing a measurement, deriving observed_at from it', async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    const out = await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'GET /ok responds 200 with an empty array',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
      tags: ['API', 'Orders'],
    })

    expect(out.isError).toBe(false)
    const claim = out.envelope['data'] as Record<string, unknown>
    expect(claim['claim_id']).toMatch(/^c_/)
    expect(claim['observed_by']).toBe('test-agent')
    expect(claim['tags']).toEqual(['api', 'orders']) // normalized like a project
    expect(claim['retracted']).toBeNull()
    expect(typeof claim['observed_at']).toBe('string')
  })

  it('refuses an observation from another project, without leaking existence', async () => {
    client = open()
    const obs = await measureOk(client, 'project-a')
    const out = await call(client, 'facts.recall.assert', {
      project: 'project-b',
      statement: 'borrowed evidence',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
    })
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('OBSERVATION_NOT_FOUND')
  })

  it('rejects an empty evidence list', async () => {
    client = open()
    const out = await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'trust me',
      evidence: [],
      observed_by: 'test-agent',
    })
    expect(out.isError).toBe(true)
  })

  it('requires observed_at with external evidence and forbids it without', async () => {
    client = open()
    const missing = await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'the operator saw the panel',
      evidence: [{ type: 'external', description: 'screenshot from the operator' }],
      observed_by: 'human',
    })
    expect((missing.envelope['error'] as { code: string }).code).toBe('OBSERVED_AT_REQUIRED')

    const obs = await measureOk(client, 'p')
    const forbidden = await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'claiming my own time',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
      observed_at: '2020-01-01T00:00:00+00:00',
    })
    expect((forbidden.envelope['error'] as { code: string }).code).toBe('OBSERVED_AT_NOT_ALLOWED')
  })

  it('rejects an external observed_at that is not a parseable timestamp', async () => {
    client = open()
    const out = await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'the operator saw the panel',
      evidence: [{ type: 'external', description: 'a screenshot' }],
      observed_by: 'human',
      observed_at: 'last tuesday',
    })
    // Unparseable time would read as age 0 and slip past every time filter.
    expect((out.envelope['error'] as { code: string }).code).toBe('INVALID_INPUT')
  })
})

describe('nothing is ever deleted', () => {
  it('after retract the file has grown and the prefix is identical byte for byte', async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    const asserted = await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'GET /ok responds 200',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
    })
    const claimId = (asserted.envelope['data'] as { claim_id: string }).claim_id

    const before = readFileSync(claimsPath('p'))

    const retracted = await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: claimId,
      reason: 'the endpoint now returns 500',
      by: 'test-agent',
    })
    expect(retracted.isError).toBe(false)

    const after = readFileSync(claimsPath('p'))
    expect(after.length).toBeGreaterThan(before.length)
    // Not "equivalent" — the same bytes in the same places.
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
  })

  it('history returns both events in order', async () => {
    client = open()
    const claimId = await assertCiting(client, await measureOk(client, 'p'))
    await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: claimId,
      reason: 'superseded by observation',
      by: 'test-agent',
    })

    const out = await call(client, 'facts.recall.history', { project: 'p', claim_id: claimId })
    const data = out.envelope['data'] as {
      events: { op: string; seq: number }[]
      current: { retracted: unknown }
    }
    expect(data.events.map((e) => e.op)).toEqual(['assert', 'retract'])
    expect(data.events[0]!.seq).toBeLessThan(data.events[1]!.seq)
    expect(data.current.retracted).not.toBeNull()
  })

  it('every byte survives a sequence of asserts and retracts', async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    let previous = Buffer.alloc(0)

    for (let i = 0; i < 4; i++) {
      const asserted = await call(client, 'facts.recall.assert', {
        project: 'p',
        statement: `claim number ${i}`,
        evidence: [{ type: 'observation', observation_id: obs }],
        observed_by: 'test-agent',
      })
      let current = readFileSync(claimsPath('p'))
      expect(current.subarray(0, previous.length).equals(previous)).toBe(true)
      previous = current

      const claimId = (asserted.envelope['data'] as { claim_id: string }).claim_id
      await call(client, 'facts.recall.retract', {
        project: 'p',
        claim_id: claimId,
        reason: 'rotating',
        by: 'test-agent',
      })
      current = readFileSync(claimsPath('p'))
      expect(current.subarray(0, previous.length).equals(previous)).toBe(true)
      previous = current
    }
  })

  it('retracting twice reports it and writes no second line', async () => {
    client = open()
    const claimId = await assertCiting(client, await measureOk(client, 'p'))
    await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: claimId,
      reason: 'first',
      by: 'a',
    })
    const sizeAfterFirst = statSync(claimsPath('p')).size

    const second = await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: claimId,
      reason: 'second',
      by: 'b',
    })
    expect((second.envelope['error'] as { code: string }).code).toBe('ALREADY_RETRACTED')
    expect(statSync(claimsPath('p')).size).toBe(sizeAfterFirst)
  })

  it('refuses a superseded_by cycle', async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    const mk = async (statement: string) => {
      const r = await call(client!, 'facts.recall.assert', {
        project: 'p',
        statement,
        evidence: [{ type: 'observation', observation_id: obs }],
        observed_by: 'test-agent',
      })
      return (r.envelope['data'] as { claim_id: string }).claim_id
    }
    const a = await mk('claim a')
    const b = await mk('claim b')

    const self = await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: a,
      reason: 'self',
      by: 'x',
      superseded_by: a,
    })
    expect((self.envelope['error'] as { code: string }).code).toBe('CIRCULAR_SUPERSEDE')

    // a -> b, then b -> a would close the loop.
    await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: a,
      reason: 'replaced by b',
      by: 'x',
      superseded_by: b,
    })
    const loop = await call(client, 'facts.recall.retract', {
      project: 'p',
      claim_id: b,
      reason: 'replaced by a',
      by: 'x',
      superseded_by: a,
    })
    expect((loop.envelope['error'] as { code: string }).code).toBe('CIRCULAR_SUPERSEDE')
  })
})

describe('the log survives damage without rewriting it', () => {
  it('discards an unterminated tail and keeps everything confirmed', async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'confirmed claim',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
    })
    client.close()

    // Simulate a power cut mid-fsync: bytes with no closing newline.
    appendFileSync(claimsPath('p'), '{"seq":99,"partial":true')

    client = open()
    const out = await call(client, 'facts.recall.query', { project: 'p' })
    expect(out.isError).toBe(false)
    const data = out.envelope['data'] as { total_matched: number }
    expect(data.total_matched).toBe(1)
  })

  it('skips a corrupt line in the middle, warns, and still answers', async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'first claim',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
    })
    client.close()

    const lines = readFileSync(claimsPath('p'), 'utf8').split('\n').filter(Boolean)
    writeFileSync(claimsPath('p'), [lines[0], '{ this is not json }', ''].join('\n'))

    client = open()
    const out = await call(client, 'facts.recall.query', { project: 'p' })
    expect(out.isError).toBe(false)
    expect((out.envelope['data'] as { total_matched: number }).total_matched).toBe(1)
    const warnings = out.envelope['warnings'] as { code: string }[]
    expect(warnings.map((w) => w.code)).toContain('LOG_LINE_UNREADABLE')
  })
})

describe('recall never measures', () => {
  it('answers with the service down, opening zero sockets', async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'GET /ok responded 200',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
    })

    // Take the service down. The registry must not notice or care.
    await fx.close()

    // Every outbound connection — http, https, ws, wss — goes through
    // Socket.prototype.connect, so counting calls there counts sockets opened.
    const connect = vi.spyOn(Socket.prototype, 'connect')
    try {
      const out = await call(client, 'facts.recall.query', { project: 'p' })
      expect(out.isError).toBe(false)
      expect((out.envelope['data'] as { total_matched: number }).total_matched).toBe(1)
      expect(connect).not.toHaveBeenCalled()
    } finally {
      connect.mockRestore()
    }
  })

  it('hands back remeasure_with instead of pretending to know the current state', async () => {
    client = open()
    await assertCiting(client, await measureOk(client, 'p'), 'GET /ok responded 200')

    const out = await call(client, 'facts.recall.query', { project: 'p' })
    const claim = (out.envelope['data'] as { claims: Record<string, unknown>[] }).claims[0]!
    const rm = claim['remeasure_with'] as { tool: string; arguments: Record<string, unknown> }
    expect(rm.tool).toBe('facts.measure.http')
    expect(rm.arguments['url']).toBe(`${fx.origin}/ok`)
    expect(rm.arguments['project']).toBe('p')
  })

  it('remeasure_with carries no credentials', async () => {
    client = open()
    const measured = await call(client, 'facts.measure.http', {
      project: 'p',
      url: `${fx.origin}/echo-auth`,
      headers: { authorization: 'Bearer a-very-secret-token-here' },
    })
    await assertCiting(
      client,
      measured.envelope['observation_id'] as string,
      'the authenticated route answered',
    )

    const out = await call(client, 'facts.recall.query', { project: 'p' })
    const claim = (out.envelope['data'] as { claims: Record<string, unknown>[] }).claims[0]!
    const rm = claim['remeasure_with'] as { arguments: Record<string, unknown> }
    // Neither the secret nor a redacted placeholder pretending to be one.
    expect(JSON.stringify(rm)).not.toContain('a-very-secret-token-here')
    expect(JSON.stringify(rm)).not.toContain('redacted')
  })
})

describe('the query filters without ranking and hides retracted by default', () => {
  beforeEach(async () => {
    client = open()
    const obs = await measureOk(client, 'p')
    for (const [statement, tags] of [
      ['orders endpoint answers', ['api', 'orders']],
      ['health endpoint answers', ['api', 'health']],
      ['the panel renders', ['ui']],
    ] as const) {
      await call(client, 'facts.recall.assert', {
        project: 'p',
        statement,
        evidence: [{ type: 'observation', observation_id: obs }],
        observed_by: 'test-agent',
        tags: [...tags],
      })
    }
  })

  it('filters by substring, case-insensitively', async () => {
    const out = await call(client!, 'facts.recall.query', { project: 'p', text: 'ENDPOINT' })
    expect((out.envelope['data'] as { total_matched: number }).total_matched).toBe(2)
  })

  it('filters by tags as a conjunction', async () => {
    const both = await call(client!, 'facts.recall.query', {
      project: 'p',
      tags: ['api', 'orders'],
    })
    expect((both.envelope['data'] as { total_matched: number }).total_matched).toBe(1)
  })

  it('hides retracted claims by default but never loses them', async () => {
    const all = await call(client!, 'facts.recall.query', { project: 'p' })
    const first = (all.envelope['data'] as { claims: { claim_id: string }[] }).claims[0]!
    await call(client!, 'facts.recall.retract', {
      project: 'p',
      claim_id: first.claim_id,
      reason: 'no longer true',
      by: 'test-agent',
    })

    const visible = await call(client!, 'facts.recall.query', { project: 'p' })
    expect((visible.envelope['data'] as { total_matched: number }).total_matched).toBe(2)

    const included = await call(client!, 'facts.recall.query', {
      project: 'p',
      include_retracted: true,
    })
    expect((included.envelope['data'] as { total_matched: number }).total_matched).toBe(3)

    const only = await call(client!, 'facts.recall.query', { project: 'p', only_retracted: true })
    expect((only.envelope['data'] as { total_matched: number }).total_matched).toBe(1)
  })

  it('paginates with an opaque cursor', async () => {
    const page = await call(client!, 'facts.recall.query', { project: 'p', limit: 2 })
    const data = page.envelope['data'] as { claims: unknown[]; next_cursor: string | null }
    expect(data.claims).toHaveLength(2)
    expect(data.next_cursor).not.toBeNull()

    const next = await call(client!, 'facts.recall.query', {
      project: 'p',
      limit: 2,
      cursor: data.next_cursor,
    })
    const rest = next.envelope['data'] as { claims: unknown[]; next_cursor: string | null }
    expect(rest.claims).toHaveLength(1)
    expect(rest.next_cursor).toBeNull()
  })

  it('evidence:ref keeps responses small; full brings the snapshot', async () => {
    const ref = await call(client!, 'facts.recall.query', { project: 'p', limit: 1 })
    const refClaim = (ref.envelope['data'] as { claims: Record<string, unknown>[] }).claims[0]!
    expect(JSON.stringify(refClaim['evidence'])).not.toContain('snapshot')

    const full = await call(client!, 'facts.recall.query', {
      project: 'p',
      limit: 1,
      evidence: 'full',
    })
    const fullClaim = (full.envelope['data'] as { claims: Record<string, unknown>[] }).claims[0]!
    expect(JSON.stringify(fullClaim['evidence'])).toContain('snapshot')

    const none = await call(client!, 'facts.recall.query', {
      project: 'p',
      limit: 1,
      evidence: 'none',
    })
    const noneClaim = (none.envelope['data'] as { claims: Record<string, unknown>[] }).claims[0]!
    expect(noneClaim['evidence']).toEqual([])
  })
})

// ── The three that cannot fail ──────────────────────────────────────────────

describe('each claim carries its own age, not the age of the query', () => {
  it('derives age_seconds per claim from its own observed_at', async () => {
    const clock = new FakeClock(new Date('2026-09-22T10:00:00.000Z'))
    client = open({ clock })

    const obs = await measureOk(client, 'p')
    await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'an old claim',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
    })

    // An hour passes, then a second claim is made.
    clock.advance(3_600_000)
    const obs2 = await measureOk(client, 'p', '/text')
    await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'a fresh claim',
      evidence: [{ type: 'observation', observation_id: obs2 }],
      observed_by: 'test-agent',
    })

    const out = await call(client, 'facts.recall.query', {
      project: 'p',
      order: 'observed_asc',
      stale_seconds: 1800,
    })
    const claims = (out.envelope['data'] as { claims: Record<string, unknown>[] }).claims

    const old = claims[0]!
    const fresh = claims[1]!
    expect(old['age_seconds'] as number).toBeCloseTo(3600, 0)
    expect(fresh['age_seconds'] as number).toBeCloseTo(0, 0)
    // Different ages in one response: the query's own age is not imposed on them.
    expect(old['age_seconds']).not.toEqual(fresh['age_seconds'])
    // stale is arithmetic against the caller's threshold, nothing more.
    expect(old['stale']).toBe(true)
    expect(fresh['stale']).toBe(false)
  })
})

describe('a clock that jumps backwards never yields a negative age', () => {
  it('clamps at zero instead of reporting a time in the future', async () => {
    const clock = new FakeClock(new Date('2026-09-22T10:00:00.000Z'))
    client = open({ clock })

    const obs = await measureOk(client, 'p')
    await call(client, 'facts.recall.assert', {
      project: 'p',
      statement: 'a claim made before the clock jumped',
      evidence: [{ type: 'observation', observation_id: obs }],
      observed_by: 'test-agent',
    })

    // NTP correction, suspend, a container starting with the wrong time.
    clock.jumpWallClock(-10_000)

    const out = await call(client, 'facts.recall.query', { project: 'p' })
    const claim = (out.envelope['data'] as { claims: Record<string, unknown>[] }).claims[0]!
    expect(claim['age_seconds'] as number).toBeGreaterThanOrEqual(0)
    expect(out.envelope['age_seconds'] as number).toBeGreaterThanOrEqual(0)
  })
})

describe('projects are isolated', () => {
  it('a query on B never returns claims from A', async () => {
    client = open()
    const obsA = await measureOk(client, 'project-a')
    await call(client, 'facts.recall.assert', {
      project: 'project-a',
      statement: 'a secret belonging to A',
      evidence: [{ type: 'observation', observation_id: obsA }],
      observed_by: 'test-agent',
    })

    const out = await call(client, 'facts.recall.query', { project: 'project-b' })
    expect(out.isError).toBe(false)
    expect((out.envelope['data'] as { total_matched: number }).total_matched).toBe(0)
    expect(JSON.stringify(out.envelope)).not.toContain('a secret belonging to A')
  })

  it('a claim id from A is not resolvable from B', async () => {
    client = open()
    const obsA = await measureOk(client, 'project-a')
    const asserted = await call(client, 'facts.recall.assert', {
      project: 'project-a',
      statement: 'A claim',
      evidence: [{ type: 'observation', observation_id: obsA }],
      observed_by: 'test-agent',
    })
    const claimId = (asserted.envelope['data'] as { claim_id: string }).claim_id

    const out = await call(client, 'facts.recall.history', {
      project: 'project-b',
      claim_id: claimId,
    })
    expect((out.envelope['error'] as { code: string }).code).toBe('CLAIM_NOT_FOUND')
  })
})
