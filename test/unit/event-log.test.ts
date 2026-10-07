import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../../src/store/event-log.js'
import { SystemClock } from '../../src/kernel/clock.js'

const logs: EventLog<unknown>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const l of logs.splice(0)) await l.close()
})

async function openLog(path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')) {
  const log = new EventLog<{ n: number }>(path, new SystemClock())
  logs.push(log as EventLog<unknown>)
  const opened = await log.open()
  expect(opened.ok).toBe(true)
  return { log, path }
}

const line = (seq: number, key: string) =>
  JSON.stringify({ seq, id: `e_${seq}`, at: '2026-01-01T00:00:00Z', op: 'assert', key, body: {} })

describe('append', () => {
  it('numbers events from 1 without gaps, across single and batched appends', async () => {
    const { log } = await openLog()
    await log.append('assert', 'a', { n: 1 })
    const batch = await log.appendBatch([
      { op: 'assert', key: 'b', body: { n: 2 } },
      { op: 'assert', key: 'c', body: { n: 3 } },
    ])
    expect(batch.ok && batch.value.map((r) => r.seq)).toEqual([2, 3])
    const { events } = await log.scan()
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('accepts an empty batch as a no-op', async () => {
    const { log, path } = await openLog()
    const r = await log.appendBatch([])
    expect(r.ok && r.value).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('refuses to write before open', async () => {
    const log = new EventLog<{ n: number }>(
      join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl'),
      new SystemClock(),
    )
    const r = await log.append('assert', 'a', { n: 1 })
    expect(!r.ok && r.error.code).toBe('STORAGE_ERROR')
  })

  /** Makes the next write through any file handle land 10 bytes, then fail. */
  async function tearNextWrite(path: string): Promise<void> {
    const probe = await open(path, 'r')
    const proto = Object.getPrototypeOf(probe) as { write: (...a: unknown[]) => Promise<unknown> }
    await probe.close()
    const realWrite = proto.write
    vi.spyOn(proto, 'write').mockImplementationOnce(async function (this: unknown, data: unknown) {
      await realWrite.call(this, String(data).slice(0, 10))
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
  }

  it('rolls a torn write back, so the next append is not lost with it', async () => {
    const { log, path } = await openLog()
    await log.append('assert', 'a', { n: 1 })
    await tearNextWrite(path)

    const failed = await log.append('assert', 'b', { n: 2 })
    expect(!failed.ok && failed.error.code).toBe('STORAGE_ERROR')

    const next = await log.append('assert', 'c', { n: 3 })
    expect(next.ok).toBe(true)
    const { events, warnings } = await log.scan()
    expect(events.map((e) => e.key)).toEqual(['a', 'c'])
    expect(events.map((e) => e.seq)).toEqual([1, 2])
    expect(warnings).toEqual([])
  })

  it('refuses to append onto torn bytes it cannot remove, until it can', async () => {
    const { log, path } = await openLog()
    await log.append('assert', 'a', { n: 1 })
    await tearNextWrite(path)
    // Read-only: the rollback's truncate now fails, while the open handle
    // could still append — exactly the case that would fuse lines.
    chmodSync(path, 0o444)
    try {
      await log.append('assert', 'b', { n: 2 })
      const refused = await log.append('assert', 'c', { n: 3 })
      expect(!refused.ok && refused.error.message).toContain('refusing to append')
    } finally {
      chmodSync(path, 0o644)
    }

    // Writable again: the pending rollback runs first, and the log is clean.
    expect((await log.append('assert', 'd', { n: 4 })).ok).toBe(true)
    const { events, warnings } = await log.scan()
    expect(events.map((e) => e.key)).toEqual(['a', 'd'])
    expect(warnings).toEqual([])
  })

  it('never hands a write that failed to the views', async () => {
    const { log, path } = await openLog()
    await log.append('assert', 'a', { n: 1 })
    expect((await log.history('a')).events).toHaveLength(1) // views built
    await tearNextWrite(path)
    await log.append('assert', 'b', { n: 2 })

    expect((await log.history('b')).events).toEqual([])
    await log.append('assert', 'c', { n: 3 })
    expect((await log.historyOf(['a', 'b', 'c'])).byKey.get('c')?.[0]?.seq).toBe(2)
  })
})

describe('views', () => {
  /** A view that counts how often the log rebuilt it. */
  function countingView() {
    const seen: string[] = []
    let resets = 0
    return {
      view: {
        reset: () => {
          resets++
          seen.length = 0
        },
        apply: (e: { key: string }) => void seen.push(e.key),
      },
      seen,
      resets: () => resets,
    }
  }

  it('builds once, then follows appends without reading the file again', async () => {
    const { log } = await openLog()
    await log.append('assert', 'a', { n: 1 })
    const counter = countingView()
    log.attach(counter.view)

    await log.refresh()
    for (let n = 2; n <= 6; n++) {
      await log.append('assert', `k${n}`, { n })
      await log.history(`k${n}`)
    }
    expect(counter.resets()).toBe(1)
    expect(counter.seen).toEqual(['a', 'k2', 'k3', 'k4', 'k5', 'k6'])
  })

  it('rebuilds when the file changed behind the process, and reports what it found', async () => {
    const { log, path } = await openLog()
    await log.append('assert', 'a', { n: 1 })
    const counter = countingView()
    log.attach(counter.view)
    await log.refresh()

    appendFileSync(path, 'not json\n')
    const warnings = await log.refresh()
    expect(counter.resets()).toBe(2)
    expect(warnings.map((w) => w.code)).toContain('LOG_LINE_UNREADABLE')
  })

  it('locates lines by bytes, so multibyte text before them does not shift them', async () => {
    const { log } = await openLog()
    await log.append('assert', 'a', { n: 1, note: 'ñandú — verificación' } as never)
    await log.append('assert', 'b', { n: 2 })
    expect((await log.history('b')).events[0]?.body).toEqual({ n: 2 })
    // And again after a rebuild, which computes offsets from the file itself.
    log.attach(countingView().view)
    expect((await log.history('b')).events[0]?.body).toEqual({ n: 2 })
  })

  it('reads a located line back as null once it was edited by hand', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, line(1, 'a') + '\n')
    const { log } = await openLog(path)
    const at: { offset: number; length: number }[] = []
    log.attach({ reset: () => (at.length = 0), apply: (_e, where) => void at.push(where) })
    await log.refresh()
    writeFileSync(path, 'x'.repeat(at[0]!.length) + '\n')
    expect(await log.read(at)).toEqual([null])
  })
})

describe('open', () => {
  it('refuses a symlink in place of the log', async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'plinth-log-'))
    const outside = join(mkdtempSync(join(tmpdir(), 'plinth-outside-')), 'target.jsonl')
    writeFileSync(outside, '')
    try {
      symlinkSync(outside, join(dir, 'l.jsonl'), 'file')
    } catch {
      ctx.skip() // file symlinks need a privilege Windows does not grant by default
    }
    const log = new EventLog(join(dir, 'l.jsonl'), new SystemClock())
    const r = await log.open()
    expect(!r.ok && r.error.code).toBe('STORAGE_ERROR')
  })

  it('continues the sequence of an existing log', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, [line(1, 'a'), line(2, 'b')].join('\n') + '\n')
    const { log } = await openLog(path)
    const r = await log.append('assert', 'c', { n: 3 })
    expect(r.ok && r.value.seq).toBe(3)
  })

  it('does not restart at 1 when the final line is corrupt', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, [line(1, 'a'), line(2, 'b'), '{ not json }'].join('\n') + '\n')
    const { log } = await openLog(path)
    const r = await log.append('assert', 'c', { n: 3 })
    // Restarting at 1 would reissue a sequence number already on disk.
    expect(r.ok && r.value.seq).toBe(3)
  })

  it('discards an unterminated tail and reports it on every scan', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, line(1, 'a') + '\n')
    appendFileSync(path, '{"seq":2,"partial')
    const { log } = await openLog(path)
    const { events, warnings } = await log.scan()
    expect(events).toHaveLength(1)
    expect(warnings.map((w) => w.code)).toContain('PARTIAL_TAIL_TRUNCATED')
  })

  it('treats a file that is one unterminated line as empty', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, '{"seq":1,"never finished')
    const { log } = await openLog(path)
    const r = await log.append('assert', 'a', { n: 1 })
    expect(r.ok && r.value.seq).toBe(1)
  })
})

describe('scan reports damage without repairing it', () => {
  it('warns about a gap in the sequence', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, [line(1, 'a'), line(3, 'c')].join('\n') + '\n')
    const { log } = await openLog(path)
    const { events, warnings } = await log.scan()
    expect(events).toHaveLength(2)
    expect(warnings.map((w) => w.code)).toContain('LOG_SEQ_GAP')
  })

  it('skips a line that parses but lacks required fields', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, [line(1, 'a'), '{"seq":2}', line(3, 'c')].join('\n') + '\n')
    const { log } = await openLog(path)
    const { events, warnings } = await log.scan()
    expect(events.map((e) => e.key)).toEqual(['a', 'c'])
    expect(warnings.map((w) => w.code)).toContain('LOG_LINE_UNREADABLE')
  })

  it.each([
    ['no body', { seq: 2, id: 'e_2', at: 't', op: 'assert', key: 'b' }],
    ['a null body', { seq: 2, id: 'e_2', at: 't', op: 'assert', key: 'b', body: null }],
    ['no id', { seq: 2, at: 't', op: 'assert', key: 'b', body: {} }],
    ['no time', { seq: 2, id: 'e_2', op: 'assert', key: 'b', body: {} }],
    ['not an object', 42],
  ])('skips a line with %s rather than hand it to a reader', async (_label, bad) => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, [line(1, 'a'), JSON.stringify(bad), line(3, 'c')].join('\n') + '\n')
    const { log } = await openLog(path)
    const { events, warnings } = await log.scan()
    expect(events.map((e) => e.key)).toEqual(['a', 'c'])
    expect(warnings.map((w) => w.code)).toContain('LOG_LINE_UNREADABLE')
  })

  it('returns nothing for a log that was never written', async () => {
    const { log } = await openLog()
    expect(await log.scan()).toEqual({ events: [], warnings: [] })
  })

  it('groups several keys in one pass', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plinth-log-')), 'l.jsonl')
    writeFileSync(path, [line(1, 'a'), line(2, 'b'), line(3, 'a')].join('\n') + '\n')
    const { log } = await openLog(path)
    const { byKey } = await log.historyOf(['a', 'missing'])
    expect(byKey.get('a')?.map((e) => e.seq)).toEqual([1, 3])
    expect(byKey.has('missing')).toBe(false)
    expect((await log.historyOf([])).byKey.size).toBe(0)
  })
})
