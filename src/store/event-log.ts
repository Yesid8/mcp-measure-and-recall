import { lstat, open, stat, truncate, type FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../kernel/result.js'
import { toIsoWithOffset, type Clock } from '../kernel/clock.js'
import { IdPrefix, newId } from '../kernel/ulid.js'
import { WarningCodes, type Warning } from '../kernel/envelope.js'

/**
 * An append-only event log. One line = one event.
 *
 * There is no update and no delete — not discouraged, absent from the
 * interface. That is invariant N5 turned into types.
 *
 * Writes fsync one batch at a time. Reads go through views kept in memory —
 * a key index, and whatever projection a caller attaches — built from one
 * pass over the file and then fed every event this process appends. The
 * instance lock makes this process the only writer, so the views stay exact;
 * a file that changed size behind it anyway is read again rather than trusted.
 * Measured before adding: a full scan per read cost 1.7 s at 5 000 claims.
 */

/** One line of the log, as written. */
export interface LoggedEvent<B> {
  /** 1, 2, 3… with no gaps unless the file was damaged; scan() reports gaps. */
  readonly seq: number
  readonly id: string
  /** When the line was written, not when its subject was observed. */
  readonly at: string
  /** The domain's verb. The log stores it and never interprets it. */
  readonly op: string
  /** The entity it concerns; replaying one key's events yields its state. */
  readonly key: string
  readonly body: B
}

export interface NewEvent<B> {
  readonly op: string
  readonly key: string
  readonly body: B
}

export interface AppendReceipt {
  readonly seq: number
  readonly id: string
  readonly at: string
  readonly bytes: number
}

export interface ScanResult<B> {
  readonly events: readonly LoggedEvent<B>[]
  readonly warnings: readonly Warning[]
}

/** Where one event's line sits in the file, newline excluded. */
export interface Locator {
  readonly offset: number
  readonly length: number
}

/**
 * Something kept in step with the log. reset() and then apply() for every
 * readable event, in file order, whenever the log rebuilds its views; apply()
 * alone for each event this process appends afterwards.
 */
export interface LogView<B> {
  reset(): void
  apply(event: LoggedEvent<B>, at: Locator): void
}

/** The built-in view: which lines hold each key's events. */
class KeyIndex<B> implements LogView<B> {
  readonly byKey = new Map<string, Locator[]>()
  reset(): void {
    this.byKey.clear()
  }
  apply(event: LoggedEvent<B>, at: Locator): void {
    const list = this.byKey.get(event.key)
    if (list === undefined) this.byKey.set(event.key, [at])
    else list.push(at)
  }
}

/** Read size when walking the file backwards; lines longer than this still work. */
const TAIL_WINDOW_BYTES = 64 * 1024

/** One append-only JSONL file. Open once per process; the instance lock ensures it. */
export class EventLog<B> {
  readonly #path: string
  readonly #clock: Clock
  #handle: FileHandle | null = null
  #nextSeq = 1
  /**
   * Bytes on disk that belong to acknowledged events. A write that fails part
   * way is rolled back to this length, so the torn bytes cannot fuse with the
   * next append into one unreadable line.
   */
  #confirmedBytes = 0
  /** Set while a failed write's partial bytes are still on disk. */
  #torn = false
  /**
   * Raised when opening discarded a partial tail, and attached to every scan
   * from then on: a caller reading the log deserves to know bytes were dropped,
   * and open() has no channel of its own to say so.
   */
  #openWarnings: Warning[] = []

  /**
   * Serializes writers, and view rebuilds against them: a rebuild interleaved
   * with an append could index the same event twice, or miss it.
   */
  #queue: Promise<unknown> = Promise.resolve()

  readonly #index = new KeyIndex<B>()
  readonly #views: LogView<B>[] = [this.#index]
  /** File length the views reflect; null until they are first built. */
  #viewBytes: number | null = null
  /** Damage found by the last rebuild, reported with every read. */
  #viewWarnings: Warning[] = []

  constructor(path: string, clock: Clock) {
    this.#path = path
    this.#clock = clock
  }

  /**
   * Opens the stream, repairing only a partial tail.
   *
   * An fsync can be cut in half by a power failure, so the LAST line may be
   * incomplete — never one in the middle, because writes are serialized and
   * sequential. Truncating that tail is the only destructive write this package
   * ever performs, and only on a line that was never acknowledged to anyone.
   */
  async open(): Promise<Result<void>> {
    try {
      // lstat, not stat: a symlink in place of the log could point anywhere,
      // and the data root is the only place this process writes. A directory
      // is refused too — Windows opens one for appending without complaint and
      // fails only on the first write.
      const exists = await lstat(this.#path).catch(() => null)
      if (exists !== null && !exists.isFile()) {
        return Err(toolError(ErrorCodes.STORAGE_ERROR, 'the event log path is not a regular file'))
      }
      if (exists !== null && exists.size > 0) {
        const repaired = await this.#truncatePartialTail(exists.size)
        if (!repaired.ok) return repaired
      }
      this.#confirmedBytes = (await stat(this.#path).catch(() => null))?.size ?? 0
      this.#handle = await open(this.#path, 'a')
      // Only the last sequence number is needed here. Scanning the whole file
      // would make the first call of a session pay for the entire history, and
      // the integrity warnings it would collect are reported by each scan()
      // anyway, at the point where a caller can act on them.
      this.#nextSeq = (await this.#lastSeq(this.#confirmedBytes)) + 1
      return Ok(undefined)
    } catch (e) {
      return Err(toolError(ErrorCodes.STORAGE_ERROR, 'could not open the event log', { cause: e }))
    }
  }

  /**
   * Offset of the last '\n' before `end`, or -1 if there is none.
   *
   * Walks back window by window with no upper bound: a line that embeds an HTTP
   * body can be far longer than any fixed window, and a search that gives up at
   * the window's edge leaves a torn line for the next append to fuse onto.
   */
  async #lastNewlineBefore(fh: FileHandle, end: number): Promise<number> {
    const buf = Buffer.alloc(TAIL_WINDOW_BYTES)
    for (let hi = end; hi > 0;) {
      const lo = Math.max(0, hi - TAIL_WINDOW_BYTES)
      const n = hi - lo
      await fh.read(buf, 0, n, lo)
      const at = buf.subarray(0, n).lastIndexOf(0x0a)
      if (at !== -1) return lo + at
      hi = lo
    }
    return -1
  }

  /**
   * The sequence number of the last readable line, or 0 for an empty log.
   *
   * Reads backwards line by line rather than parsing the file: the answer is at
   * the end and the file can be arbitrarily long. It keeps walking past a
   * corrupt final line, because falling back to 0 would reissue sequence numbers
   * already on disk. An I/O failure throws, and open() refuses the log rather
   * than guess.
   */
  async #lastSeq(size: number): Promise<number> {
    if (size === 0) return 0
    const fh = await open(this.#path, 'r')
    try {
      // After the tail repair the file ends in '\n', at index size - 1.
      let end = size - 1
      while (end > 0) {
        const start = (await this.#lastNewlineBefore(fh, end)) + 1
        if (end > start) {
          const buf = Buffer.alloc(end - start)
          await fh.read(buf, 0, buf.length, start)
          const parsed = parseLine<B>(buf.toString('utf8'))
          if (parsed !== null) return parsed.seq
        }
        end = start - 1
      }
      return 0
    } finally {
      await fh.close().catch(() => {})
    }
  }

  async #truncatePartialTail(size: number): Promise<Result<void>> {
    let lastNewline: number
    const fh = await open(this.#path, 'r')
    try {
      lastNewline = await this.#lastNewlineBefore(fh, size)
    } catch (e) {
      return Err(
        toolError(ErrorCodes.STORAGE_ERROR, 'could not inspect the log tail', { cause: e }),
      )
    } finally {
      // Closed before truncating: Windows refuses to truncate a file held open.
      await fh.close().catch(() => {})
    }

    // With no newline at all, the whole file is one line nobody was told about.
    const goodBytes = lastNewline + 1
    if (goodBytes === size) return Ok(undefined)
    try {
      await truncate(this.#path, goodBytes)
    } catch (e) {
      return Err(
        toolError(ErrorCodes.STORAGE_ERROR, 'could not truncate a partial tail', { cause: e }),
      )
    }
    this.#openWarnings.push({
      code: WarningCodes.PARTIAL_TAIL_TRUNCATED,
      message: 'an unterminated trailing line was discarded when opening the log',
      detail: { discarded_bytes: size - goodBytes },
    })
    return Ok(undefined)
  }

  async close(): Promise<void> {
    await this.#queue.catch(() => {})
    await this.#handle?.close().catch(() => {})
    this.#handle = null
  }

  append(op: string, key: string, body: B): Promise<Result<AppendReceipt>> {
    return this.appendBatch([{ op, key, body }]).then((r) =>
      r.ok ? Ok(r.value[0]!) : Err(r.error),
    )
  }

  /**
   * Several events, one commit. Atomic: either all land or none do.
   *
   * Domain operations that are several things at once — retracting a claim and
   * asserting the one that replaces it — leave a registry that lies when they
   * land half-done.
   */
  appendBatch(events: readonly NewEvent<B>[]): Promise<Result<AppendReceipt[]>> {
    return this.#enqueue(() => this.#writeBatch(events))
  }

  /** Runs `work` after everything already queued, and before anything queued later. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work)
    this.#queue = run.catch(() => {})
    return run
  }

  /**
   * Appends only if a check against the key's current events still holds.
   *
   * Reading, deciding and writing as three separate steps leaves gaps: two
   * concurrent retractions of one claim both see it un-retracted and both
   * write. The check runs inside the write queue, which is the only place in
   * the process where nothing can interleave.
   */
  appendIf(
    events: readonly NewEvent<B>[],
    key: string,
    precondition: (history: readonly LoggedEvent<B>[]) => Result<void>,
  ): Promise<Result<AppendReceipt[]>> {
    return this.#enqueue(async () => {
      const { events: history } = await this.#historyNow([key])
      const allowed = precondition(history)
      if (!allowed.ok) return Err(allowed.error)
      return this.#writeBatch(events)
    })
  }

  async #writeBatch(events: readonly NewEvent<B>[]): Promise<Result<AppendReceipt[]>> {
    if (this.#handle === null) {
      return Err(toolError(ErrorCodes.STORAGE_ERROR, 'the event log is not open'))
    }
    if (this.#torn && !(await this.#rollback())) {
      return Err(
        toolError(
          ErrorCodes.STORAGE_ERROR,
          'a previous write left partial bytes that could not be removed; refusing to append onto them',
        ),
      )
    }
    if (events.length === 0) return Ok([])

    const at = toIsoWithOffset(this.#clock.now())
    const receipts: AppendReceipt[] = []
    const records: LoggedEvent<B>[] = []
    const lines: string[] = []

    for (const e of events) {
      const seq = this.#nextSeq + receipts.length
      const id = newId(IdPrefix.event)
      const record = { seq, id, at, op: e.op, key: e.key, body: e.body }
      const line = JSON.stringify(record)
      // A split line would break the file forever. JSON.stringify cannot produce
      // a raw newline, but the cost of checking is nothing and the cost of being
      // wrong is permanent.
      if (line.includes('\n')) {
        return Err(
          toolError(ErrorCodes.STORAGE_ERROR, 'refusing to write a line containing a newline'),
        )
      }
      records.push(record)
      lines.push(line)
      receipts.push({ seq, id, at, bytes: Buffer.byteLength(line, 'utf8') + 1 })
    }

    const payload = lines.join('\n') + '\n'
    const startsAt = this.#confirmedBytes
    try {
      // One write and one fsync for the whole batch: that is what makes it atomic.
      await this.#handle.write(payload)
      await this.#handle.sync()
      this.#nextSeq += receipts.length
      this.#confirmedBytes += Buffer.byteLength(payload, 'utf8')
      this.#feedViews(records, receipts, startsAt)
      return Ok(receipts)
    } catch (e) {
      // Some bytes may have landed. Cut back to the last acknowledged byte, or
      // the next append would fuse onto them and be lost with them. A rollback
      // that fails is remembered and retried before the next write, which is
      // refused while it keeps failing.
      this.#torn = !(await this.#rollback())
      return Err(
        toolError(ErrorCodes.STORAGE_ERROR, 'could not append to the event log', { cause: e }),
      )
    }
  }

  /**
   * Truncates the file to the last acknowledged byte. By path, not through the
   * handle: Windows refuses to truncate a handle opened for appending (EPERM),
   * while truncating by path leaves that handle writing at the new end.
   */
  async #rollback(): Promise<boolean> {
    try {
      await truncate(this.#path, this.#confirmedBytes)
      return true
    } catch {
      return false
    }
  }

  /**
   * Full forward scan, tolerant of damage.
   *
   * A line that fails to parse is SKIPPED, counted and reported as a warning —
   * never repaired by rewriting. A gap in seq is a warning too, not a failure:
   * the file is still the best source available, and hiding the gap would be
   * worse than showing it.
   */
  async scan(): Promise<ScanResult<B>> {
    const events: LoggedEvent<B>[] = []
    const { warnings } = await this.#pass((event) => events.push(event))
    return { events, warnings: [...this.#openWarnings, ...warnings] }
  }

  /** The auditable guarantee: what the log actually holds for this key. */
  history(key: string): Promise<ScanResult<B>> {
    return this.#enqueue(() => this.#historyNow([key]))
  }

  /** The events of several keys, each read straight from its lines. */
  historyOf(keys: Iterable<string>): Promise<{
    byKey: Map<string, LoggedEvent<B>[]>
    warnings: readonly Warning[]
  }> {
    return this.#enqueue(async () => {
      const wanted = [...new Set(keys)]
      const { events, warnings } = await this.#historyNow(wanted)
      const byKey = new Map<string, LoggedEvent<B>[]>()
      for (const e of events) {
        const list = byKey.get(e.key)
        if (list === undefined) byKey.set(e.key, [e])
        else list.push(e)
      }
      return { byKey, warnings }
    })
  }

  /**
   * Adds a view kept in step with the log. It is filled on the next read, so
   * attaching one costs a single pass over the file, paid once.
   */
  attach(view: LogView<B>): void {
    this.#views.push(view)
    this.#viewBytes = null
  }

  /**
   * Brings every view up to date with the file and returns the damage it
   * holds: the warnings every read of the log must carry.
   */
  refresh(): Promise<readonly Warning[]> {
    return this.#enqueue(() => this.#refreshNow())
  }

  /**
   * The events at these places in the file, one per locator and in the same
   * order; null where a line no longer reads, which an append-only file whose
   * acknowledged bytes never change only produces if edited by hand.
   */
  async read(at: readonly Locator[]): Promise<(LoggedEvent<B> | null)[]> {
    if (at.length === 0) return []
    const fh = await open(this.#path, 'r')
    try {
      const events: (LoggedEvent<B> | null)[] = []
      for (const { offset, length } of at) {
        const buf = Buffer.alloc(length)
        await fh.read(buf, 0, length, offset)
        events.push(parseLine<B>(buf.toString('utf8')))
      }
      return events
    } finally {
      await fh.close().catch(() => {})
    }
  }

  async #historyNow(keys: readonly string[]): Promise<ScanResult<B>> {
    const warnings = await this.#refreshNow()
    const at = keys
      .flatMap((k) => this.#index.byKey.get(k) ?? [])
      .sort((a, b) => a.offset - b.offset)
    const events = (await this.read(at)).filter((e): e is LoggedEvent<B> => e !== null)
    return { events, warnings }
  }

  /** Rebuilds the views when the file is not the length they reflect. Run inside the queue. */
  async #refreshNow(): Promise<readonly Warning[]> {
    const size = (await stat(this.#path).catch(() => null))?.size ?? 0
    if (this.#viewBytes !== size) {
      for (const view of this.#views) view.reset()
      const { warnings, bytes } = await this.#pass((event, at) => {
        for (const view of this.#views) view.apply(event, at)
      })
      this.#viewWarnings = warnings
      this.#viewBytes = bytes
    }
    return [...this.#openWarnings, ...this.#viewWarnings]
  }

  /**
   * Hands a just-written batch to the views, if they were current when it was
   * written. If they were not, they stay stale and the next read rebuilds them.
   */
  #feedViews(
    records: readonly LoggedEvent<B>[],
    receipts: readonly AppendReceipt[],
    startsAt: number,
  ): void {
    if (this.#viewBytes !== startsAt) return
    let offset = startsAt
    records.forEach((record, n) => {
      const length = receipts[n]!.bytes - 1
      for (const view of this.#views) view.apply(record, { offset, length })
      offset += length + 1
    })
    this.#viewBytes = offset
  }

  /**
   * One pass over the file, line by line, with each line's place in it.
   *
   * Works on bytes rather than decoded text so the offsets are exact: a line
   * holding multibyte characters is longer in bytes than in characters.
   */
  async #pass(
    visit: (event: LoggedEvent<B>, at: Locator) => void,
  ): Promise<{ warnings: Warning[]; bytes: number }> {
    const warnings: Warning[] = []
    if ((await stat(this.#path).catch(() => null)) === null) return { warnings, bytes: 0 }

    let lineNo = 0
    let expectedSeq = 1
    const line = (bytes: Buffer, offset: number): void => {
      lineNo++
      const text = bytes.toString('utf8')
      if (text.trim().length === 0) return
      const parsed = parseLine<B>(text)
      if (parsed === null) {
        warnings.push({
          code: WarningCodes.LOG_LINE_UNREADABLE,
          message: `line ${lineNo} of the log could not be read and was skipped`,
          detail: { line: lineNo },
        })
        return
      }
      if (parsed.seq !== expectedSeq) {
        warnings.push({
          code: WarningCodes.LOG_SEQ_GAP,
          message: `sequence jumped from ${expectedSeq} to ${parsed.seq}`,
          detail: { expected: expectedSeq, found: parsed.seq },
        })
      }
      expectedSeq = parsed.seq + 1
      visit(parsed, { offset, length: bytes.length })
    }

    // `consumed` is the file offset where `carry` begins.
    let consumed = 0
    let carry: Buffer = Buffer.alloc(0)
    const stream = createReadStream(this.#path)
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const buf = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
        let start = 0
        let nl: number
        while ((nl = buf.indexOf(0x0a, start)) !== -1) {
          line(buf.subarray(start, nl), consumed + start)
          start = nl + 1
        }
        consumed += start
        carry = buf.subarray(start)
      }
    } finally {
      stream.destroy()
    }
    // A last line without its newline: never written by this process, but a
    // file edited by hand can end that way, and it is reported like any other.
    if (carry.length > 0) line(carry, consumed)
    return { warnings, bytes: consumed + carry.length }
  }
}

/** Returns null for anything that is not a usable event, so callers warn once. */
function parseLine<B>(line: string): LoggedEvent<B> | null {
  let parsed: LoggedEvent<B>
  try {
    parsed = JSON.parse(line) as LoggedEvent<B>
  } catch {
    return null
  }
  // Every field a reader relies on. A line missing one is as unusable as one
  // that does not parse, and reporting it beats a TypeError further on.
  if (parsed === null || typeof parsed !== 'object') return null
  if (typeof parsed.seq !== 'number' || typeof parsed.key !== 'string') return null
  if (typeof parsed.op !== 'string' || typeof parsed.id !== 'string') return null
  if (typeof parsed.at !== 'string') return null
  if (parsed.body === null || typeof parsed.body !== 'object') return null
  return parsed
}
