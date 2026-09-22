import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { captureConsole, ndjsonLog, serveStdio } from '../../src/transport/stdio.js'
import type { ProtocolServer } from '../../src/protocol/server.js'

/** A transport wired to a fake server, with stdout parsed line by line. */
function harness(handle: (msg: unknown) => Promise<unknown>) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: unknown[] = []
  let err = ''
  let buf = ''
  stdout.on('data', (c: Buffer) => {
    buf += c.toString()
    let i: number
    while ((i = buf.indexOf('\n')) !== -1) {
      out.push(JSON.parse(buf.slice(0, i)))
      buf = buf.slice(i + 1)
    }
  })
  stderr.on('data', (c: Buffer) => (err += c.toString()))
  let closes = 0
  const stop = serveStdio({ handle } as unknown as ProtocolServer, {
    stdin,
    stdout,
    stderr,
    onClose: () => closes++,
  })
  const settle = () => new Promise((r) => setTimeout(r, 20))
  return { stdin, out, stderr: () => err, closes: () => closes, stop, settle }
}

describe('serveStdio framing', () => {
  it('handles several messages delivered in one chunk', async () => {
    const seen: unknown[] = []
    const h = harness(async (m) => (seen.push(m), null))
    h.stdin.write('{"a":1}\n{"a":2}\n\n{"a":3}\n')
    await h.settle()
    expect(seen).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it('assembles a message split across chunks', async () => {
    const seen: unknown[] = []
    const h = harness(async (m) => (seen.push(m), null))
    h.stdin.write('{"a":')
    h.stdin.write('1}\n')
    await h.settle()
    expect(seen).toEqual([{ a: 1 }])
  })

  it('answers unparseable JSON with -32700, with the time, and keeps serving', async () => {
    const h = harness(async () => ({ jsonrpc: '2.0', id: 1, result: {} }))
    h.stdin.write('{not json\n{"id":1}\n')
    await h.settle()
    const error = (h.out[0] as { error: { code: number; data: Record<string, unknown> } }).error
    expect(error.code).toBe(-32700)
    expect(error.data).toMatchObject({ age_seconds: 0 })
    expect(Number.isNaN(Date.parse(error.data['observed_at'] as string))).toBe(false)
    expect(h.out[1]).toMatchObject({ id: 1, result: {} })
  })

  it('refuses an unterminated message past the size cap without losing later ones', async () => {
    const seen: unknown[] = []
    const h = harness(async (m) => (seen.push(m), null))
    h.stdin.write('x'.repeat(16 * 1024 * 1024 + 1))
    await h.settle()
    expect((h.out[0] as { error: { code: number } }).error.code).toBe(-32700)
    h.stdin.write('{"after":true}\n')
    await h.settle()
    expect(seen).toEqual([{ after: true }])
  })

  it('still answers a request whose handling throws', async () => {
    const h = harness(async () => {
      throw new Error('bug')
    })
    h.stdin.write('{"jsonrpc":"2.0","id":7,"method":"x"}\n')
    await h.settle()
    expect(h.out[0]).toMatchObject({ id: 7, error: { code: -32603, data: { age_seconds: 0 } } })
    expect(h.stderr()).toContain('transport failure')
  })

  it('stays silent on a throwing notification, which has no id to answer', async () => {
    const h = harness(async () => {
      throw new Error('bug')
    })
    h.stdin.write('{"jsonrpc":"2.0","method":"x"}\n')
    await h.settle()
    expect(h.out).toEqual([])
  })

  it('answers with a string id exactly as sent', async () => {
    const h = harness(async () => {
      throw new Error('bug')
    })
    h.stdin.write('{"jsonrpc":"2.0","id":"req-1","method":"x"}\n')
    await h.settle()
    expect(h.out[0]).toMatchObject({ id: 'req-1', error: { code: -32603 } })
  })

  it.each(['[1,2]', '{"id":{"n":1}}', '"text"'])(
    'stays silent when %s fails and carries no usable id',
    async (line) => {
      const h = harness(async () => {
        throw 'not an Error'
      })
      h.stdin.write(line + '\n')
      await h.settle()
      expect(h.out).toEqual([])
      expect(h.stderr()).toContain('not an Error')
    },
  )

  it('calls onClose once, though stdin emits both end and close', async () => {
    const h = harness(async () => null)
    h.stdin.end()
    h.stdin.destroy()
    await h.settle()
    expect(h.closes()).toBe(1)
  })

  it('stops reading when stopped', async () => {
    const seen: unknown[] = []
    const h = harness(async (m) => (seen.push(m), null))
    h.stop()
    h.stdin.write('{"a":1}\n')
    await h.settle()
    expect(seen).toEqual([])
  })
})

describe('ndjsonLog', () => {
  it('writes one JSON object per line', () => {
    let out = ''
    const sink = new PassThrough()
    sink.on('data', (c: Buffer) => (out += c.toString()))
    ndjsonLog(sink)('info', 'hello', { n: 1 })
    const entry = JSON.parse(out.trim()) as Record<string, unknown>
    expect(entry).toMatchObject({ level: 'info', msg: 'hello', fields: { n: 1 } })
  })

  it('redacts secrets in the message and in the fields', () => {
    let out = ''
    const sink = new PassThrough()
    sink.on('data', (c: Buffer) => (out += c.toString()))
    ndjsonLog(sink)('error', 'GET https://h/?token=abc123 failed', {
      headers: { authorization: 'Bearer abcdef0123456789' },
      stack: 'at https://alice:pw@h/x',
    })
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('abcdef0123456789')
    expect(out).not.toContain(':pw@')
  })

  it('never throws on fields it cannot serialize', () => {
    let out = ''
    const sink = new PassThrough()
    sink.on('data', (c: Buffer) => (out += c.toString()))
    expect(() => ndjsonLog(sink)('warn', 'odd', { big: 10n })).not.toThrow()
    expect(JSON.parse(out.trim())).toMatchObject({ msg: 'odd', fields: '[unserializable]' })
  })
})

describe('captureConsole', () => {
  function captured(run: () => void): Record<string, unknown>[] {
    let out = ''
    const sink = new PassThrough()
    sink.on('data', (c: Buffer) => (out += c.toString()))
    const restore = captureConsole(sink)
    try {
      run()
    } finally {
      restore()
    }
    return out
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('maps each console method to a level', () => {
    const entries = captured(() => {
      console.log('a')
      console.info('b')
      console.warn('c')
      console.error('d')
      console.debug('e')
    })
    expect(entries.map((e) => [e['level'], e['msg']])).toEqual([
      ['info', 'a'],
      ['info', 'b'],
      ['warn', 'c'],
      ['error', 'd'],
      ['debug', 'e'],
    ])
  })

  it('joins arguments, keeping strings raw and rendering what JSON cannot', () => {
    const bare = new Error('no stack')
    delete bare.stack
    const [entry] = captured(() => console.log('n =', 1, { k: true }, undefined, bare))
    expect(entry!['msg']).toBe('n = 1 {"k":true} undefined Error: no stack')
  })

  it('puts the original console back', () => {
    const before = console.log
    captured(() => undefined)
    expect(console.log).toBe(before)
  })
})
