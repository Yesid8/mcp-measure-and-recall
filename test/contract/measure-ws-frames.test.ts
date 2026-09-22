import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rawFrame, wsFixture, type WsFixture, type WsFixtureOptions } from '../fixtures/ws.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'

/** The frame decoder's edges: length encodings, masking, control frames, caps. */

let fx: WsFixture | null = null
let client: TestClient | null = null

afterEach(async () => {
  await client?.closeAsync()
  client = null
  await fx?.close()
  fx = null
})

async function listen(options: WsFixtureOptions, args: Record<string, unknown> = {}) {
  fx = await wsFixture(options)
  client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-wsf-')) })
  const out = readToolResult(
    await client.request('tools/call', {
      name: 'facts.measure.ws',
      arguments: { project: 'p', url: `${fx.origin}/`, listen_seconds: 0.3, ...args },
    }),
  )
  const data = out.envelope['data'] as {
    messages: { payload: unknown; payload_format: string; type: string; bytes: number }[]
    message_count: number
    bytes_total: number
    negotiated_subprotocol: string | null
    closed: { by: string; code: number | null } | null
  }
  const warnings = (out.envelope['warnings'] as { code: string }[]).map((w) => w.code)
  return { out, data, warnings }
}

describe('length encodings', () => {
  it('decodes a 16-bit length (126..65535 bytes)', async () => {
    const text = 'a'.repeat(300)
    const { data } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x1, payload: text })),
    })
    expect(data.messages[0]!.payload).toBe(text)
  })

  it('decodes a 64-bit length (65536 bytes and more)', async () => {
    const text = 'b'.repeat(70_000)
    const { data } = await listen(
      { script: (s) => s.write(rawFrame({ opcode: 0x1, payload: text })) },
      { max_message_bytes: 100_000 },
    )
    expect(data.messages[0]!.bytes).toBe(70_000)
  })

  it('decodes a frame whose bytes arrive in several chunks', async () => {
    const frame = rawFrame({ opcode: 0x1, payload: '{"split":true}' })
    const { data } = await listen({
      script: (s) => {
        s.write(frame.subarray(0, 3))
        setTimeout(() => s.write(frame.subarray(3)), 30)
      },
    })
    expect(data.messages[0]!.payload).toEqual({ split: true })
  })
})

describe('frame kinds', () => {
  it('unmasks a masked frame from the server', async () => {
    const { data } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x1, payload: 'masked', mask: true })),
    })
    expect(data.messages[0]!.payload).toBe('masked')
  })

  it('base64-encodes a binary message', async () => {
    const bytes = Buffer.from([1, 2, 3, 250])
    const { data } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x2, payload: bytes })),
    })
    expect(data.messages[0]!.type).toBe('binary')
    expect(data.messages[0]!.payload).toBe(bytes.toString('base64'))
  })

  it('answers a ping with a pong carrying the same payload, and records neither', async () => {
    const { data } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x9, payload: 'hb' })),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(fx!.received.some((f) => f.opcode === 0xa && f.payload.toString() === 'hb')).toBe(true)
    expect(data.message_count).toBe(0)
  })

  it('ignores an unsolicited pong', async () => {
    const { data } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0xa, payload: '' })),
    })
    expect(data.message_count).toBe(0)
  })

  it('records a close frame without a status code', async () => {
    const { data } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x8, payload: '' })),
    })
    expect(data.closed).toMatchObject({ by: 'server', code: null })
  })
})

describe('what the client cannot interpret is reported, not decoded', () => {
  it('ends early with a warning on reserved bits it did not negotiate', async () => {
    const { out, warnings } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x1, payload: 'x', rsv: 0b100 })),
    })
    expect(out.isError).toBe(false)
    expect(warnings).toContain('WS_PROTOCOL_ERROR')
  })

  it('warns when the window ends inside a fragmented message', async () => {
    const { data, warnings } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x1, payload: 'half', fin: false })),
    })
    expect(data.message_count).toBe(0)
    expect(warnings).toContain('WS_MESSAGE_INCOMPLETE')
  })

  it('drops a continuation that belongs to no message', async () => {
    const { data } = await listen({
      script: (s) => s.write(rawFrame({ opcode: 0x0, payload: 'orphan' })),
    })
    expect(data.message_count).toBe(0)
  })
})

describe('handshake', () => {
  it('reports the subprotocol the server chose', async () => {
    const { data } = await listen({ subprotocol: 'proto.v1' }, { subprotocols: ['proto.v1'] })
    expect(data.negotiated_subprotocol).toBe('proto.v1')
  })

  it('refuses a server whose Sec-WebSocket-Accept does not match', async () => {
    const { out } = await listen({ badAccept: true })
    expect((out.envelope['error'] as { code: string }).code).toBe('WS_HANDSHAKE_FAILED')
  })
})

describe('caps', () => {
  it('truncates one message at max_message_bytes', async () => {
    const { data, warnings } = await listen(
      { script: (s) => s.write(rawFrame({ opcode: 0x1, payload: 'x'.repeat(500) })) },
      { max_message_bytes: 100 },
    )
    expect(data.messages[0]!.bytes).toBe(100)
    expect(warnings).toContain('MESSAGES_TRUNCATED')
  })

  it('stops recording at max_total_bytes', async () => {
    const { data } = await listen(
      {
        script: (s) => {
          for (let i = 0; i < 5; i++) s.write(rawFrame({ opcode: 0x1, payload: 'y'.repeat(40) }))
        },
      },
      { max_total_bytes: 100 },
    )
    expect(data.bytes_total).toBeLessThanOrEqual(120)
    expect(data.message_count).toBeLessThan(5)
  })
})

describe('sending', () => {
  it('sends a delayed message after the delay, recorded as outbound', async () => {
    const { data } = await listen(
      { behaviour: 'silent' },
      { send: [{ payload: 'later', delay_ms: 100 }] },
    )
    const sent = (data.messages as { direction?: string; payload: unknown }[]).filter(
      (m) => m.direction === 'out',
    )
    expect(sent.map((m) => m.payload)).toEqual(['later'])
    expect(fx!.received.some((f) => f.opcode === 0x1 && f.payload.toString() === 'later')).toBe(
      true,
    )
  })

  it('does not send a delayed message after the window has ended', async () => {
    const { data } = await listen(
      { behaviour: 'silent' },
      { send: [{ payload: 'too late', delay_ms: 2000 }] },
    )
    expect(data.message_count).toBe(0)
  })
})
