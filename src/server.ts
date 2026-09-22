import { ProtocolServer } from './protocol/server.js'
import { SystemClock } from './kernel/clock.js'
import { ndjsonLog } from './transport/stdio.js'
import { createMeasureHttp, DEFAULT_MAX_REDIRECTS } from './tools/measure-http.js'
import { createMeasureWs } from './tools/measure-ws.js'
import {
  createRecallAssert,
  createRecallHistory,
  createRecallQuery,
  createRecallRetract,
  DEFAULT_STALE_SECONDS,
} from './tools/recall.js'
import { describePolicy } from './config.js'
import { StoreRegistry } from './store/store.js'
import { dataRoot } from './store/paths.js'
import type { ToolDefinition } from './kernel/tool.js'
import type { Writable } from 'node:stream'
import type { Clock } from './kernel/clock.js'
import type { NetPolicy } from './policy/net.js'
import { acquireInstanceLock, type LockHandle } from './store/instance-lock.js'
import type { Result } from './kernel/result.js'
import { createRequire } from 'node:module'

// Read, not hard-coded, so server/discover can never announce a stale version.
// package.json sits one level above both src/ and dist/.
const { version: VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string
}

/**
 * Sent in server/discover. The model reads it before choosing a tool, so it
 * states the rules that make answers trustworthy rather than describing tools.
 */
export const INSTRUCTIONS = [
  'This server holds facts. It measures and it remembers; it never judges.',
  '',
  'Two rules govern every answer:',
  '1. If something can be measured now, it is not answered from memory. recall.* never measures;',
  '   it returns each claim with its age and, when the evidence is a measurement, remeasure_with:',
  '   the exact tool and arguments to measure it again yourself.',
  '2. Every response carries the time it was observed, so staleness is visible. Each item in a',
  '   collection carries its own age, not the age of the query.',
  '',
  'No output field is a judgement. `ok` means only "the observation could be taken": a cleanly',
  'received HTTP 500 is ok:true with data.http_status 500. Whether that is good is yours to decide.',
  '',
  'Nothing is ever deleted. A claim is retracted with a reason, and the original line stays.',
  '',
  "Measurements are taken from this server's network position.",
].join('\n')

/** Every option has a production default; tests override what they control. */
export interface BuildOptions {
  readonly clock?: Clock
  /** Where the NDJSON log goes. */
  readonly stderr?: Writable
  /** Replaces the six tools. */
  readonly tools?: readonly ToolDefinition<never, never>[]
  /** Defaults to loopback only. main.ts passes the one loadConfig() read. */
  readonly policy?: NetPolicy
  /** recall.* stale threshold when the caller gives none. Defaults to an hour. */
  readonly defaultStaleSeconds?: number
  /** Defaults to PLINTH_DATA_DIR, then ~/.plinth. */
  readonly dataDir?: string
}

/** A server that is assembled but not yet serving or holding its lock. */
export interface BuiltServer {
  readonly server: ProtocolServer
  readonly stores: StoreRegistry
  /**
   * Takes the instance lock for the data directory.
   *
   * Call it before serving. It is separate from build() so tests can share a
   * directory deliberately, and so a caller can report the failure its own way.
   */
  lock(): Promise<Result<LockHandle>>
  /** Closes every open log, then releases the lock if this server holds it. */
  close(): Promise<void>
}

/** Wires the six tools, the store and the protocol layer. Opens nothing yet. */
export function build(opts: BuildOptions = {}): BuiltServer {
  const clock = opts.clock ?? new SystemClock()
  const log = ndjsonLog(opts.stderr ?? process.stderr)
  // Redirects are off unless a caller asks (follow_redirects defaults to false);
  // maxRedirects is only the cap on how many hops such a request may follow.
  const policy: NetPolicy = opts.policy ?? {
    profile: 'loopback',
    maxRedirects: DEFAULT_MAX_REDIRECTS,
  }
  const staleSeconds = opts.defaultStaleSeconds ?? DEFAULT_STALE_SECONDS
  // Resolved once: the lock and the stores must agree on the directory.
  const dir = opts.dataDir ?? dataRoot()
  const stores = new StoreRegistry(clock, dir)

  const tools =
    opts.tools ??
    ([
      createMeasureHttp(policy),
      createMeasureWs(policy),
      createRecallAssert(stores, staleSeconds),
      createRecallRetract(stores, staleSeconds),
      createRecallQuery(stores, staleSeconds),
      createRecallHistory(stores, staleSeconds),
    ] as unknown as readonly ToolDefinition<never, never>[])

  const server = new ProtocolServer({
    info: { name: 'facts-mcp', version: VERSION },
    instructions: `${INSTRUCTIONS}\n${describePolicy(policy)}`,
    tools,
    clock,
    log,
    recordObservation: async (envelope) => {
      const store = await stores.get(envelope.project)
      return store.ok ? store.value.recordObservation(envelope) : store
    },
  })

  let lockHandle: LockHandle | null = null

  return {
    server,
    stores,
    lock: async () => {
      const acquired = await acquireInstanceLock(dir)
      if (acquired.ok) lockHandle = acquired.value
      return acquired
    },
    close: async () => {
      await stores.closeAll()
      await lockHandle?.release()
      lockHandle = null
    },
  }
}
