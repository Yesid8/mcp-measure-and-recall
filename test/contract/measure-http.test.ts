import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Socket } from 'node:net'
import { httpFixture, fakeResolver, type HttpFixture } from '../fixtures/http.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'
import { createMeasureHttp } from '../../src/tools/measure-http.js'
import { resolveAndValidate } from '../../src/policy/net.js'
import { classifyIp } from '../../src/policy/ip.js'
import type { ToolDefinition } from '../../src/kernel/tool.js'
import type { NetPolicy } from '../../src/policy/net.js'

/**
 * Stage A2 exit criteria: network policy and measure.http.
 */

let fx: HttpFixture
let client: TestClient | null = null

beforeEach(async () => {
  fx = await httpFixture()
})
afterEach(async () => {
  client?.close()
  client = null
  await fx.close()
})

function withPolicy(policy: NetPolicy): TestClient {
  return inProcessClient({
    tools: [createMeasureHttp(policy) as unknown as ToolDefinition<never, never>],
  })
}

const loopback: NetPolicy = { profile: 'loopback' }

async function measure(c: TestClient, args: Record<string, unknown>) {
  return readToolResult(
    await c.request('tools/call', { name: 'facts.measure.http', arguments: args }),
  )
}

describe('IP classification covers the edges that matter', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'], // IPv4-mapped: must not read as public
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['169.254.169.254', 'link-local'], // cloud metadata
    ['fe80::1', 'link-local'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'], // just outside the private range
    ['192.168.1.1', 'private'],
    ['fc00::1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.128.0.1', 'public'], // just outside cgnat
    ['8.8.8.8', 'public'],
    ['2001:4860:4860::8888', 'public'],
  ])('classifies %s as %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected)
  })
})

describe('the policy validates the address, not the name', () => {
  it('rejects a *.localhost name that resolves to a public IP', async () => {
    const res = await resolveAndValidate('http://evil.localhost/', {
      profile: 'loopback',
      resolver: fakeResolver({ 'evil.localhost': [{ address: '203.0.113.7', family: 4 }] }),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('HOST_NOT_ALLOWED')
  })

  it('rejects a name with one loopback and one public address', async () => {
    // All addresses must pass, not any: a mixed record is the classic attack.
    const res = await resolveAndValidate('http://mixed.test/', {
      profile: 'loopback',
      resolver: fakeResolver({
        'mixed.test': [
          { address: '127.0.0.1', family: 4 },
          { address: '203.0.113.7', family: 4 },
        ],
      }),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('HOST_NOT_ALLOWED')
      expect(JSON.stringify(res.error.detail)).toContain('203.0.113.7')
    }
  })

  it('rejects 169.254.169.254 under all four profiles, including allowlist', async () => {
    for (const profile of ['deny-all', 'loopback', 'private', 'allowlist'] as const) {
      const res = await resolveAndValidate('http://169.254.169.254/latest/meta-data/', {
        profile,
        allowHosts: ['169.254.169.254:80'], // even when explicitly listed
      })
      expect(res.ok, `profile ${profile} must deny link-local`).toBe(false)
    }
  })

  it('denies everything under deny-all', async () => {
    const res = await resolveAndValidate('http://127.0.0.1:1/', { profile: 'deny-all' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('HOST_NOT_ALLOWED')
  })

  it('allowlist needs an exact host:port, with no wildcards', async () => {
    const policy: NetPolicy = {
      profile: 'allowlist',
      allowHosts: ['api.internal:8443'],
      resolver: fakeResolver({ 'api.internal': [{ address: '203.0.113.9', family: 4 }] }),
    }
    const right = await resolveAndValidate('https://api.internal:8443/x', policy)
    expect(right.ok).toBe(true)

    const wrongPort = await resolveAndValidate('https://api.internal:9000/x', policy)
    expect(wrongPort.ok).toBe(false)

    const subdomain = await resolveAndValidate('https://evil.api.internal:8443/x', policy)
    expect(subdomain.ok).toBe(false)
  })

  it('rejects a non-http scheme', async () => {
    const res = await resolveAndValidate('file:///etc/passwd', loopback)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('URL_INVALID')
  })
})

describe('allowlist is checked on top of the address policy, never instead of it', () => {
  // An allowlisted name is only a promise about the name. What it resolves to
  // can change after the operator wrote the list — DNS rebinding — so every
  // address is classified exactly as under any other profile.
  const tool = (name: string, address: string, family = 4) =>
    withPolicy({
      profile: 'allowlist',
      allowHosts: [`${name}:80`],
      resolver: fakeResolver({ [name]: [{ address, family }] }),
    })

  it.each([
    ['169.254.169.254', 4], // cloud metadata
    ['169.254.10.20', 4],
    ['fe80::1', 6],
    ['::ffff:169.254.169.254', 6], // link-local hidden in an IPv4-mapped address
    ['100.64.0.1', 4], // carrier-grade NAT
    ['0.0.0.0', 4], // unspecified
  ])(
    'refuses an allowed name that resolves to %s, without opening a socket',
    async (address, family) => {
      client = tool('api.allowed.test', address, family)
      const connect = vi.spyOn(Socket.prototype, 'connect')
      try {
        const out = await measure(client, { project: 'p', url: 'http://api.allowed.test/' })
        expect((out.envelope['error'] as { code: string }).code).toBe('HOST_NOT_ALLOWED')
        expect(connect).not.toHaveBeenCalled()
      } finally {
        connect.mockRestore()
      }
    },
  )

  it('refuses an allowed name when any one of its addresses is link-local', async () => {
    client = withPolicy({
      profile: 'allowlist',
      allowHosts: ['api.allowed.test:80'],
      resolver: fakeResolver({
        'api.allowed.test': [
          { address: '203.0.113.10', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
      }),
    })
    const out = await measure(client, { project: 'p', url: 'http://api.allowed.test/' })
    expect((out.envelope['error'] as { code: string }).code).toBe('HOST_NOT_ALLOWED')
  })

  it('measures an allowed name that resolves to a permitted address — the spy counts', async () => {
    const port = Number(new URL(fx.origin).port)
    client = withPolicy({
      profile: 'allowlist',
      allowHosts: [`app.allowed.test:${port}`],
      resolver: fakeResolver({ 'app.allowed.test': [{ address: '127.0.0.1', family: 4 }] }),
    })
    const connect = vi.spyOn(Socket.prototype, 'connect')
    try {
      const out = await measure(client, { project: 'p', url: `http://app.allowed.test:${port}/ok` })
      expect(out.isError, JSON.stringify(out.envelope['error'])).toBe(false)
      expect(connect).toHaveBeenCalled()
    } finally {
      connect.mockRestore()
    }
  })

  it.each(['deny-all', 'loopback', 'private', 'allowlist'] as const)(
    'denies a name resolving to link-local under %s',
    async (profile) => {
      const res = await resolveAndValidate('http://meta.test/', {
        profile,
        allowHosts: ['meta.test:80'],
        resolver: fakeResolver({ 'meta.test': [{ address: '169.254.169.254', family: 4 }] }),
      })
      expect(!res.ok && res.error.code).toBe('HOST_NOT_ALLOWED')
    },
  )
})

describe('a 500 is an observation, not an error', () => {
  it('returns ok:true, isError:false and http_status 500', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/boom` })

    expect(out.isError).toBe(false)
    expect(out.envelope['ok']).toBe(true)
    expect(out.envelope['error']).toBeNull()
    const data = out.envelope['data'] as { http_status: number; body: unknown }
    expect(data.http_status).toBe(500)
    expect(data.body).toEqual({ error: 'internal' })
  })

  it('a 404 is likewise a successful observation', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/missing` })
    expect(out.envelope['ok']).toBe(true)
    expect((out.envelope['data'] as { http_status: number }).http_status).toBe(404)
  })
})

describe('measure.http reports what it actually did', () => {
  it('reports the peer address it really connected to', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/ok` })
    const peer = (out.envelope['data'] as { peer: { address: string; port: number } }).peer
    expect(peer.address).toBe('127.0.0.1')
    expect(peer.port).toBe(fx.port)
  })

  it('carries the time and a non-negative age', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/ok` })
    expect(typeof out.envelope['observed_at']).toBe('string')
    expect(out.envelope['age_seconds'] as number).toBeGreaterThanOrEqual(0)
    expect(out.envelope['age_basis']).toBe('monotonic')
  })

  it('makes exactly one request: no implicit retries', async () => {
    client = withPolicy(loopback)
    await measure(client, { project: 'p', url: `${fx.origin}/ok` })
    expect(fx.hitCount('/ok')).toBe(1)
  })

  it('does not follow redirects by default: a 302 comes back as a 302', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/redirect-local` })
    expect((out.envelope['data'] as { http_status: number }).http_status).toBe(302)
    expect(fx.hitCount('/ok')).toBe(0)
  })

  it('revalidates every redirect hop and refuses one that leaves the profile', async () => {
    client = withPolicy({ ...loopback, maxRedirects: 3 })
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/redirect-public`,
      follow_redirects: true,
    })
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('HOST_NOT_ALLOWED')
  })

  it('follows an allowed redirect and records the chain', async () => {
    client = withPolicy({ ...loopback, maxRedirects: 3 })
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/redirect-local`,
      follow_redirects: true,
    })
    const data = out.envelope['data'] as {
      http_status: number
      redirect_chain: { http_status: number }[]
    }
    expect(data.http_status).toBe(200)
    expect(data.redirect_chain).toHaveLength(1)
  })
})

describe('bodies are described, never interpreted', () => {
  it('parses JSON when the content-type says JSON', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/ok` })
    const data = out.envelope['data'] as { body_format: string; body: unknown }
    expect(data.body_format).toBe('json')
    expect(data.body).toEqual({ orders: [] })
  })

  it('returns lying JSON as text with a warning, without correcting it', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/lying-json` })
    const data = out.envelope['data'] as { body_format: string; body: unknown }
    expect(data.body_format).toBe('text')
    expect(data.body).toBe('<html>not json</html>')
    const warnings = out.envelope['warnings'] as { code: string }[]
    expect(warnings.map((w) => w.code)).toContain('BODY_CONTENT_TYPE_MISMATCH')
  })

  it('truncates an oversized body and says so', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/big`,
      max_body_bytes: 1000,
    })
    const data = out.envelope['data'] as { body_truncated: boolean; body_bytes: number }
    expect(data.body_truncated).toBe(true)
    expect(data.body_bytes).toBeLessThanOrEqual(1000)
    expect((out.envelope['warnings'] as { code: string }[]).map((w) => w.code)).toContain(
      'BODY_TRUNCATED',
    )
  })

  it('refuses a decompression bomb instead of eating memory', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/gzip-bomb`,
      max_body_bytes: 64 * 1024 * 1024,
    })
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('DECOMPRESSION_LIMIT')
  })
})

describe('secrets never appear in the output', () => {
  it('sends the header intact but redacts it in target', async () => {
    client = withPolicy(loopback)
    const secret = 'Bearer super-secret-token-value-12345'
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/echo-auth`,
      headers: { authorization: secret },
    })

    // The destination received it whole — checked at the fixture, which is the
    // only place the unredacted value legitimately exists.
    const seen = fx.received.find((r) => r.path === '/echo-auth')
    expect(seen?.headers['authorization']).toBe(secret)

    // ...but it appears nowhere in what we hand back or store, neither in the
    // echoed body nor in target.
    const target = out.envelope['target'] as { headers: Record<string, string> }
    expect(target.headers['authorization']).toMatch(/^\[redacted:\d+ bytes\]$/)
    expect(JSON.stringify(out.envelope)).not.toContain('super-secret-token-value')
  })

  it('redacts set-cookie in the response headers', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, { project: 'p', url: `${fx.origin}/set-cookie` })
    const headers = (out.envelope['data'] as { headers: Record<string, string> }).headers
    expect(headers['set-cookie']).toMatch(/^\[redacted:\d+ bytes\]$/)
  })
})

describe('failures to observe are errors; they carry the time too', () => {
  it('a refused connection is ok:false with a mechanical message', async () => {
    client = withPolicy(loopback)
    // Port 1 on loopback: inside the profile, nothing listening.
    const out = await measure(client, { project: 'p', url: 'http://127.0.0.1:1/' })
    expect(out.isError).toBe(true)
    expect(out.envelope['ok']).toBe(false)
    expect((out.envelope['error'] as { code: string }).code).toBe('CONNECTION_REFUSED')
    expect(typeof out.envelope['observed_at']).toBe('string')
  })

  it('timeout_ms bounds the whole exchange, not just socket inactivity', async () => {
    client = withPolicy(loopback)
    const started = performance.now()
    // The peer sends a byte every 100 ms for 3 s, so it is never idle for 500 ms.
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/trickle`,
      timeout_ms: 500,
    })
    const elapsed = performance.now() - started
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('TIMEOUT')
    expect(elapsed).toBeLessThan(1500)
  })

  it('a timeout is reported as TIMEOUT, not as a hang', async () => {
    client = withPolicy(loopback)
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/slow`,
      timeout_ms: 300,
    })
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('TIMEOUT')
  })
})

describe('credentials do not follow a redirect across origins', () => {
  it('drops credential headers and says so', async () => {
    const other = await httpFixture()
    client = withPolicy({ ...loopback, maxRedirects: 2 })
    try {
      const out = await measure(client, {
        project: 'p',
        url: `${fx.origin}/redirect-other-origin?to=${other.port}`,
        headers: { authorization: 'Bearer token-for-the-first-origin' },
        follow_redirects: true,
      })

      // The second origin answered, and never saw the token.
      expect((out.envelope['data'] as { http_status: number }).http_status).toBe(200)
      const seenByOther = other.received.find((r) => r.path === '/echo-auth')
      expect(seenByOther).toBeDefined()
      expect(seenByOther?.headers['authorization']).toBeUndefined()

      // The first origin did get it: it is the one the caller addressed.
      expect(
        fx.received.find((r) => r.path === '/redirect-other-origin')?.headers['authorization'],
      ).toBe('Bearer token-for-the-first-origin')

      expect((out.envelope['warnings'] as { code: string }[]).map((w) => w.code)).toContain(
        'CREDENTIALS_DROPPED_ON_REDIRECT',
      )
    } finally {
      await other.close()
    }
  })

  it('keeps them across a same-origin redirect', async () => {
    client = withPolicy({ ...loopback, maxRedirects: 2 })
    await measure(client, {
      project: 'p',
      url: `${fx.origin}/redirect-local`,
      headers: { authorization: 'Bearer same-origin-token' },
      follow_redirects: true,
    })
    expect(fx.received.find((r) => r.path === '/ok')?.headers['authorization']).toBe(
      'Bearer same-origin-token',
    )
  })
})

describe('a redirect follows the method semantics of a real client', () => {
  it('turns a POST into a bodyless GET on 303', async () => {
    client = withPolicy({ ...loopback, maxRedirects: 2 })
    const out = await measure(client, {
      project: 'p',
      url: `${fx.origin}/redirect-303`,
      method: 'POST',
      body: { some: 'payload' },
      follow_redirects: true,
    })
    const data = out.envelope['data'] as {
      http_status: number
      body: { method: string; had_body: boolean }
    }
    expect(data.http_status).toBe(200)
    // The second hop is what a browser would send: GET, no body.
    expect(data.body.method).toBe('GET')
    expect(data.body.had_body).toBe(false)
  })
})
