import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { httpFixture, type HttpFixture } from '../fixtures/http.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'
import { createMeasureHttp } from '../../src/tools/measure-http.js'
import type { NetPolicy } from '../../src/policy/net.js'

/** Encodings, methods and redirect edge cases of facts.measure.http. */

let fx: HttpFixture
let client: TestClient

beforeEach(async () => {
  fx = await httpFixture()
})
afterEach(async () => {
  await client?.closeAsync()
  await fx.close()
})

function open(policy: NetPolicy = { profile: 'loopback', maxRedirects: 3 }): TestClient {
  client = inProcessClient({
    tools: [createMeasureHttp(policy)],
  })
  return client
}

async function measure(args: Record<string, unknown>) {
  const out = readToolResult(
    await client.request('tools/call', { name: 'facts.measure.http', arguments: args }),
  )
  return {
    out,
    data: out.envelope['data'] as Record<string, unknown>,
    warnings: (out.envelope['warnings'] as { code: string; message: string }[]).map((w) => w.code),
  }
}

describe('content encodings are decoded', () => {
  it.each([
    ['/deflate', 'deflated body'],
    ['/br', 'brotli body'],
  ])('%s', async (path, expected) => {
    open()
    const { data } = await measure({ project: 'p', url: `${fx.origin}${path}` })
    expect(data['body']).toBe(expected)
  })
})

describe('bodies are described by format', () => {
  it('base64-encodes a binary body', async () => {
    open()
    const { data } = await measure({ project: 'p', url: `${fx.origin}/binary` })
    expect(data['body_format']).toBe('base64')
    expect(data['body']).toBe(Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'))
  })

  it('reports an empty body as format none', async () => {
    open()
    const { data } = await measure({ project: 'p', url: `${fx.origin}/empty` })
    expect(data['http_status']).toBe(204)
    expect(data['body_format']).toBe('none')
    expect(data['body']).toBeNull()
  })

  it('returns no body for HEAD', async () => {
    open()
    const { data } = await measure({ project: 'p', url: `${fx.origin}/ok`, method: 'HEAD' })
    expect(data['http_status']).toBe(200)
    expect(data['body_format']).toBe('none')
  })
})

describe('request bodies', () => {
  it('sends a string body as given', async () => {
    open()
    await measure({ project: 'p', url: `${fx.origin}/echo-method`, method: 'POST', body: 'raw' })
    const seen = fx.received.find((r) => r.path === '/echo-method')
    expect(seen?.headers['content-length']).toBe('3')
  })

  it('sets content-type for an object body when the caller did not', async () => {
    open()
    const { data } = await measure({
      project: 'p',
      url: `${fx.origin}/echo-method`,
      method: 'POST',
      body: { a: 1 },
    })
    expect((data['body'] as { content_type: string }).content_type).toBe('application/json')
  })

  it('keeps a content-type the caller chose', async () => {
    open()
    const { data } = await measure({
      project: 'p',
      url: `${fx.origin}/echo-method`,
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'a,b',
    })
    expect((data['body'] as { content_type: string }).content_type).toBe('text/csv')
  })
})

describe('redirects', () => {
  it('stops at the hop limit and says so, returning the last redirect', async () => {
    open({ profile: 'loopback', maxRedirects: 2 })
    const { data, warnings } = await measure({
      project: 'p',
      url: `${fx.origin}/redirect-loop`,
      follow_redirects: true,
    })
    expect(data['http_status']).toBe(302)
    expect((data['redirect_chain'] as unknown[]).length).toBe(2)
    expect(warnings).toContain('REDIRECT_NOT_FOLLOWED')
  })

  it('returns a redirect with an unparseable Location as received, with a warning', async () => {
    open()
    const { out, data, warnings } = await measure({
      project: 'p',
      url: `${fx.origin}/redirect-bad-location`,
      follow_redirects: true,
    })
    // An observation of the peer's bad header, not a crash of ours.
    expect(out.isError).toBe(false)
    expect(data['http_status']).toBe(302)
    expect(warnings).toContain('REDIRECT_NOT_FOLLOWED')
  })

  it('does not warn when the caller did not ask to follow', async () => {
    open()
    const { warnings } = await measure({ project: 'p', url: `${fx.origin}/redirect-loop` })
    expect(warnings).toEqual([])
  })

  it('drops the body headers along with the body when 303 turns POST into GET', async () => {
    open()
    const { data } = await measure({
      project: 'p',
      url: `${fx.origin}/redirect-303`,
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: 'a,b',
      follow_redirects: true,
    })
    expect(data['body']).toEqual({ method: 'GET', had_body: false, content_type: null })
  })
})

describe('request bodies', () => {
  it.each([
    ['an object', { a: 1 }, 'application/json'],
    ['an array', [1, 2], 'application/json'],
    ['a string', 'a=b', null],
  ])('labels %s as %s', async (_label, body, contentType) => {
    open()
    const { data } = await measure({
      project: 'p',
      url: `${fx.origin}/echo-method`,
      method: 'POST',
      body,
    })
    expect(data['body']).toEqual({ method: 'POST', had_body: true, content_type: contentType })
  })
})

describe('schemes', () => {
  it.each(['ws://127.0.0.1:1/', 'wss://127.0.0.1:1/'])(
    'refuses %s, which is not HTTP',
    async (url) => {
      open()
      const { out } = await measure({ project: 'p', url })
      expect((out.envelope['error'] as { code: string }).code).toBe('URL_INVALID')
    },
  )
})

describe('cancellation', () => {
  it('stops a call cancelled while the body is still arriving, and answers nothing', async () => {
    open()
    void client.request('tools/call', {
      name: 'facts.measure.http',
      arguments: { project: 'p', url: `${fx.origin}/trickle`, timeout_ms: 10_000 },
    })
    await new Promise((r) => setTimeout(r, 300))
    const cancelledAt = performance.now()
    client.notify('notifications/cancelled', { requestId: 1 })
    await client.settled()

    // Well inside the grace the server allows a tool that ignores its signal:
    // the tool stopped itself, it was not abandoned.
    expect(performance.now() - cancelledAt).toBeLessThan(500)
    expect(client.stdoutLines()).toEqual([])
  })
})
