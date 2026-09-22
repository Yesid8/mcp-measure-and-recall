import { lstat, open, stat, truncate, type FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { CoreErrors, Err, Ok, toolError, type Result } from '../kernel/result.js'
import { toIsoWithOffset, type Clock } from '../kernel/clock.js'
import { IdPrefix, newId } from '../kernel/ulid.js'
import { WarningCodes, type Warning } from '../kernel/envelope.js'

/**
 * An append-only event log. One line = one event.
 *
 * There is no update and no delete — not discouraged, absent from the
 * interface. That is invariant N5 turned into types.
 *
 * Writes fsync one batch at a time and reads scan the file linearly, on
 * purpose. Group commit and an index are designed (docs/v2/04-almacenamiento.md)
 * but deferred until a real registry is measured to be slow: until then they
 * are complexity without evidence.
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

  /** Serializes writers inside the process: one queue per stream, no races. */
  #queue: Promise<unknown> = Promise.resolve()

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
        return Err(toolError(CoreErrors.STORAGE_ERROR, 'the event log path is not a regular file'))
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
      return Err(toolError(CoreErrors.STORAGE_ERROR, 'could not open the event log', { cause: e }))
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
        toolError(CoreErrors.STORAGE_ERROR, 'could not inspect the log tail', { cause: e }),
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
        toolError(CoreErrors.STORAGE_ERROR, 'could not truncate a partial tail', { cause: e }),
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
    const run = this.#queue.then(() => this.#writeBatch(events))
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
    const run = this.#queue.then(async () => {
      const { events: history } = await this.history(key)
      const allowed = precondition(history)
      if (!allowed.ok) return Err(allowed.error)
      return this.#writeBatch(events)
    })
    this.#queue = run.catch(() => {})
    return run
  }

  async #writeBatch(events: readonly NewEvent<B>[]): Promise<Result<AppendReceipt[]>> {
    if (this.#handle === null) {
      return Err(toolError(CoreErrors.STORAGE_ERROR, 'the event log is not open'))
    }
    if (this.#torn && !(await this.#rollback())) {
      return Err(
        toolError(
          CoreErrors.STORAGE_ERROR,
          'a previous write left partial bytes that could not be removed; refusing to append onto them',
        ),
      )
    }
    if (events.length === 0) return Ok([])

    const at = toIsoWithOffset(this.#clock.now())
    const receipts: AppendReceipt[] = []
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
          toolError(CoreErrors.STORAGE_ERROR, 'refusing to write a line containing a newline'),
        )
      }
      lines.push(line)
      receipts.push({ seq, id, at, bytes: Buffer.byteLength(line, 'utf8') + 1 })
    }

    const payload = lines.join('\n') + '\n'
    try {
      // One write and one fsync for the whole batch: that is what makes it atomic.
      await this.#handle.write(payload)
      await this.#handle.sync()
      this.#nextSeq += receipts.length
      this.#confirmedBytes += Buffer.byteLength(payload, 'utf8')
      return Ok(receipts)
    } catch (e) {
      // Some bytes may have landed. Cut back to the last acknowledged byte, or
      // the next append would fuse onto them and be lost with them. A rollback
      // that fails is remembered and retried before the next write, which is
      // refused while it keeps failing.
      this.#torn = !(await this.#rollback())
      return Err(
        toolError(CoreErrors.STORAGE_ERROR, 'could not append to the event log', { cause: e }),
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
    return this.scanWhere(() => true)
  }

  /**
   * Scans once, keeping only the events a predicate accepts.
   *
   * Callers that want a subset should use this rather than filtering the result
   * of scan(): the log holds whole HTTP bodies, so materializing every event to
   * discard most of them costs both a pass over the file and the peak memory of
   * the entire log. Warnings are always collected in full — a damaged line
   * matters to the caller whether or not it would have passed the filter.
   */
  async scanWhere(keep: (key: string, op: string) => boolean): Promise<ScanResult<B>> {
    const events: LoggedEvent<B>[] = []
    const warnings: Warning[] = [...this.#openWarnings]

    const exists = await stat(this.#path).catch(() => null)
    if (exists === null) return { events, warnings }

    const stream = createReadStream(this.#path, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })

    let lineNo = 0
    let expectedSeq = 1
    try {
      for await (const line of rl) {
        lineNo++
        if (line.trim().length === 0) continue

        const parsed = parseLine<B>(line)
        if (parsed === null) {
          warnings.push({
            code: WarningCodes.LOG_LINE_UNREADABLE,
            message: `line ${lineNo} of the log could not be read and was skipped`,
            detail: { line: lineNo },
          })
          continue
        }
        if (parsed.seq !== expectedSeq) {
          warnings.push({
            code: WarningCodes.LOG_SEQ_GAP,
            message: `sequence jumped from ${expectedSeq} to ${parsed.seq}`,
            detail: { expected: expectedSeq, found: parsed.seq },
          })
        }
        expectedSeq = parsed.seq + 1
        if (keep(parsed.key, parsed.op)) events.push(parsed)
      }
    } finally {
      rl.close()
      stream.destroy()
    }
    return { events, warnings }
  }

  /** The auditable guarantee: what the log actually holds for this key. */
  async history(key: string): Promise<ScanResult<B>> {
    return this.scanWhere((k) => k === key)
  }

  /**
   * The events of several keys in one pass.
   *
   * Resolving keys in a loop over history() re-reads the whole file per key,
   * which is O(keys x file) for work that one pass already covers.
   */
  async historyOf(keys: Iterable<string>): Promise<{
    byKey: Map<string, LoggedEvent<B>[]>
    warnings: readonly Warning[]
  }> {
    const wanted = new Set(keys)
    const byKey = new Map<string, LoggedEvent<B>[]>()
    if (wanted.size === 0) return { byKey, warnings: [] }

    const { events, warnings } = await this.scanWhere((k) => wanted.has(k))
    for (const e of events) {
      const list = byKey.get(e.key)
      if (list === undefined) byKey.set(e.key, [e])
      else list.push(e)
    }
    return { byKey, warnings }
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
