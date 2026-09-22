import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wsFixture, type WsFixture } from '../fixtures/ws.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'

/** Stage A4 exit criteria: facts.measure.ws. */

let fx: WsFixture | null = null
let client: TestClient | null = null

afterEach(async () => {
  await client?.closeAsync()
  client = null
  await fx?.close()
  fx = null
})

function open(): TestClient {
  return inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-ws-')) })
}

async function listen(c: TestClient, args: Record<string, unknown>) {
  return readToolResult(
    await c.request('tools/call', { name: 'facts.measure.ws', arguments: args }),
  )
}

describe('silence is an observation, not an error', () => {
  it('a silent socket for 2 s returns ok:true with zero messages', async () => {
    fx = await wsFixture('silent')
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 2,
    })

    expect(out.isError, JSON.stringify(out.envelope['error'])).toBe(false)
    expect(out.envelope['ok']).toBe(true)
    const data = out.envelope['data'] as {
      connected: boolean
      message_count: number
      listen_seconds_actual: number
    }
    expect(data.connected).toBe(true)
    expect(data.message_count).toBe(0)
    // The full window is served: cutting it short would misreport what was asked.
    expect(data.listen_seconds_actual).toBeGreaterThanOrEqual(1.9)
    expect(data.listen_seconds_actual).toBeLessThan(3)
  })
})

describe('schemes', () => {
  it.each(['http://127.0.0.1:1/', 'https://127.0.0.1:1/'])(
    'refuses %s rather than speak WebSocket over it in the clear',
    async (url) => {
      client = open()
      const out = await listen(client, { project: 'p', url, listen_seconds: 0.1 })
      expect((out.envelope['error'] as { code: string }).code).toBe('URL_INVALID')
    },
  )
})

describe('each message carries its own absolute time and offset', () => {
  it('records periodic messages in order, with times that advance', async () => {
    fx = await wsFixture('periodic')
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 0.6,
    })

    const data = out.envelope['data'] as {
      messages: { seq: number; at: string; offset_ms: number; payload: unknown }[]
      message_count: number
    }
    expect(data.message_count).toBeGreaterThanOrEqual(3)

    for (const m of data.messages) {
      expect(typeof m.at).toBe('string')
      expect(Number.isNaN(Date.parse(m.at))).toBe(false)
      expect(m.offset_ms).toBeGreaterThanOrEqual(0)
    }
    const offsets = data.messages.map((m) => m.offset_ms)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
    expect(data.messages[0]!.payload).toEqual({ tick: 1 })
  })

  it('parses JSON payloads without interpreting them', async () => {
    fx = await wsFixture('periodic')
    client = open()
    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 0.3,
    })
    const data = out.envelope['data'] as {
      messages: { payload_format: string; payload: unknown }[]
    }
    expect(data.messages[0]!.payload_format).toBe('json')
  })
})

describe('the connection ending is reported, not judged', () => {
  it('a server-side close is recorded with its code', async () => {
    fx = await wsFixture('close-midway')
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 5,
    })

    expect(out.isError).toBe(false)
    const data = out.envelope['data'] as {
      closed: { by: string; code: number | null } | null
      message_count: number
    }
    expect(data.closed).not.toBeNull()
    expect(data.closed!.by).toBe('server')
    expect(data.closed!.code).toBe(1001)
    expect(data.message_count).toBe(1)
  })

  it('a refused handshake is an error: it prevented observing', async () => {
    fx = await wsFixture('refuse')
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 1,
    })

    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('WS_HANDSHAKE_FAILED')
  })

  it('a refused connection is reported mechanically', async () => {
    client = open()
    const out = await listen(client, {
      project: 'p',
      url: 'ws://127.0.0.1:1/',
      listen_seconds: 1,
    })
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('CONNECTION_REFUSED')
  })
})

describe('sending and caps', () => {
  it('records sent messages with direction out', async () => {
    fx = await wsFixture('echo')
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 0.5,
      send: [{ payload: { hello: 'world' }, delay_ms: 0 }],
    })

    const data = out.envelope['data'] as {
      messages: { direction: string; payload: unknown }[]
    }
    const sent = data.messages.filter((m) => m.direction === 'out')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toEqual({ hello: 'world' })
    expect(data.messages.some((m) => m.direction === 'in')).toBe(true)
  })

  it('stops accumulating at max_messages but still serves the full window', async () => {
    fx = await wsFixture('periodic')
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 0.6,
      max_messages: 2,
    })

    const data = out.envelope['data'] as {
      message_count: number
      messages_truncated: boolean
      listen_seconds_actual: number
    }
    expect(data.message_count).toBe(2)
    expect(data.messages_truncated).toBe(true)
    expect(data.listen_seconds_actual).toBeGreaterThanOrEqual(0.5)
    expect((out.envelope['warnings'] as { code: string }[]).map((w) => w.code)).toContain(
      'MESSAGES_TRUNCATED',
    )
  })
})

describe('the network policy applies to websockets too', () => {
  it('refuses a public destination under the loopback profile', async () => {
    client = open()
    const out = await listen(client, {
      project: 'p',
      url: 'ws://93.184.216.34:80/',
      listen_seconds: 1,
    })
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('HOST_NOT_ALLOWED')
  })
})

describe('cancellation', () => {
  it('stops within 200 ms of the client cancelling, and answers nothing', async () => {
    fx = await wsFixture('silent')
    client = open()

    void client.request('tools/call', {
      name: 'facts.measure.ws',
      arguments: { project: 'p', url: `${fx.origin}/feed`, listen_seconds: 60 },
    })
    await new Promise((r) => setTimeout(r, 50))
    const cancelledAt = performance.now()
    client.notify('notifications/cancelled', { requestId: 1 })
    await client.settled()

    expect(performance.now() - cancelledAt).toBeLessThan(200)
    expect(client.stdoutLines()).toEqual([])
  })
})

describe('a fragmented message is reported as what was sent', () => {
  it('reassembles a message split across frames', async () => {
    fx = await wsFixture('fragmented')
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 0.4,
    })

    const data = out.envelope['data'] as {
      messages: { payload: unknown; payload_format: string; bytes: number }[]
      message_count: number
    }
    // One message was sent, so one message must be reported — not a half of it,
    // and not a half plus a silently dropped continuation.
    expect(data.message_count).toBe(1)
    expect(data.messages[0]!.payload).toEqual({ reading: 42, unit: 'kW' })
    expect(data.messages[0]!.payload_format).toBe('json')
  })
})

describe('caps count what was received, not what we sent', () => {
  it('an outbound send does not consume the inbound message budget', async () => {
    fx = await wsFixture('periodic') // emits an inbound tick every 100ms
    client = open()

    const out = await listen(client, {
      project: 'p',
      url: `${fx.origin}/feed`,
      listen_seconds: 0.6,
      max_messages: 2,
      send: [{ payload: { hello: 1 }, delay_ms: 0 }],
    })

    const data = out.envelope['data'] as {
      messages: { direction: string; bytes: number }[]
      message_count: number
      bytes_total: number
    }
    const inbound = data.messages.filter((m) => m.direction === 'in')
    const outbound = data.messages.filter((m) => m.direction === 'out')

    // The send is recorded, but it did not eat into the inbound cap: two
    // inbound messages still fit despite one outbound.
    expect(outbound).toHaveLength(1)
    expect(inbound).toHaveLength(2)

    // bytes_total reflects received payloads only, matching its description.
    const inboundBytes = inbound.reduce((n, m) => n + m.bytes, 0)
    expect(data.bytes_total).toBe(inboundBytes)
  })
})
