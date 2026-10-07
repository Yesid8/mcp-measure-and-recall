import { join } from 'node:path'
import { EventLog } from './event-log.js'
import { dataRoot, projectPaths } from './paths.js'
import { Err, Ok, type Result } from '../kernel/result.js'
import type { Clock } from '../kernel/clock.js'
import type { Envelope, Warning } from '../kernel/envelope.js'

/**
 * Per-project storage. Each project is isolated: its own log files, and an
 * identifier minted in project A is not resolvable from project B.
 */

/**
 * The body of a claim event. One shape for both ops, all fields optional,
 * because the log stores bodies without knowing their op: an `assert` fills
 * the first group, a `retract` the second.
 */
export interface ClaimBody {
  readonly claim_id?: string
  readonly statement?: string
  readonly evidence?: readonly EvidenceRecord[]
  readonly observed_by?: string
  readonly observed_at?: string
  readonly recorded_at?: string
  readonly tags?: readonly string[]

  readonly at?: string
  readonly by?: string
  readonly reason?: string
  readonly superseded_by?: string | null
}

/** A measurement as persisted: the envelope minus its per-call bookkeeping. */
export interface ObservationSnapshot {
  readonly tool: string
  readonly target: Readonly<Record<string, unknown>>
  readonly observed_at: string
  readonly ok: boolean
  readonly data: unknown
}

/** One line of the observations log. */
export interface StoredObservation extends ObservationSnapshot {
  readonly observation_id: string
}

export type EvidenceRecord =
  | {
      readonly type: 'observation'
      readonly observation_id: string
      /**
       * Copied into the claim when it is asserted, so a claim is auditable on
       * its own: nothing it rests on lives only in another file.
       */
      readonly snapshot: ObservationSnapshot
    }
  | { readonly type: 'external'; readonly description: string; readonly uri?: string }

/** The two logs of one project. Obtain through StoreRegistry, never directly. */
export class ProjectStore {
  readonly project: string
  readonly claims: EventLog<ClaimBody>
  readonly observations: EventLog<StoredObservation>

  private constructor(
    project: string,
    claims: EventLog<ClaimBody>,
    obs: EventLog<StoredObservation>,
  ) {
    this.project = project
    this.claims = claims
    this.observations = obs
  }

  static async open(
    project: string,
    clock: Clock,
    root = dataRoot(),
  ): Promise<Result<ProjectStore>> {
    const paths = await projectPaths(root, project)
    if (!paths.ok) return Err(paths.error)

    const claims = new EventLog<ClaimBody>(join(paths.value.logs, 'claims.jsonl'), clock)
    const observations = new EventLog<StoredObservation>(
      join(paths.value.logs, 'observations.jsonl'),
      clock,
    )
    // Two independent files; opening each reads its tail to repair a partial
    // line and recover the last seq. The full scan is deferred to the first read.
    const [openedClaims, openedObservations] = await Promise.all([
      claims.open(),
      observations.open(),
    ])
    if (!openedClaims.ok) {
      await observations.close()
      return Err(openedClaims.error)
    }
    if (!openedObservations.ok) {
      await claims.close()
      return Err(openedObservations.error)
    }

    return Ok(new ProjectStore(project, claims, observations))
  }

  async close(): Promise<void> {
    await this.claims.close()
    await this.observations.close()
  }

  /**
   * Records an observation so it can be cited and compared later.
   *
   * Returns the append's Result instead of swallowing it: a failed write means
   * the caller holds an observation_id that recall.assert will not resolve, and
   * the caller has to be told so while the cause is still known.
   */
  async recordObservation(envelope: Envelope<unknown>): Promise<Result<void>> {
    const written = await this.observations.append('observe', envelope.observation_id, {
      observation_id: envelope.observation_id,
      tool: envelope.tool,
      target: envelope.target,
      observed_at: envelope.observed_at,
      ok: envelope.ok,
      data: envelope.data,
    })
    return written.ok ? Ok(undefined) : Err(written.error)
  }

  /**
   * Resolves the observations a claim cites, each read straight from its line
   * through the log's key index rather than by scanning every measurement ever
   * taken. The last event per id wins: an id is written once today, and
   * reducing to the latest keeps this correct if a stream ever records more.
   */
  async findObservations(ids: Iterable<string>): Promise<{
    found: Map<string, StoredObservation>
    warnings: readonly Warning[]
  }> {
    const { byKey, warnings } = await this.observations.historyOf(ids)
    const found = new Map<string, StoredObservation>()
    for (const [id, events] of byKey) {
      const latest = events.at(-1)?.body
      if (latest !== undefined) found.set(id, latest)
    }
    return { found, warnings }
  }
}

/**
 * Opens one store per project, keeping them for the life of the process.
 *
 * Projects are created on first use; there is nothing to declare.
 */
export class StoreRegistry {
  readonly #open = new Map<string, Promise<Result<ProjectStore>>>()
  readonly #clock: Clock
  readonly #root: string

  constructor(clock: Clock, root = dataRoot()) {
    this.#clock = clock
    this.#root = root
  }

  /**
   * Caches the in-flight promise, not the resolved store.
   *
   * Two concurrent calls for a project that is not open yet would both get past
   * an `if (!has)` check and open it twice. The loser's file handles become
   * unreachable — closeAll() only walks the map — and its EventLogs carry their
   * own #nextSeq, so writes through the two instances collide on one sequence
   * number and corrupt the log. Storing the promise before the first await
   * closes that window entirely.
   */
  get(project: string): Promise<Result<ProjectStore>> {
    const inFlight = this.#open.get(project)
    if (inFlight !== undefined) return inFlight

    const opening = ProjectStore.open(project, this.#clock, this.#root).then((result) => {
      // A failed open must not be cached, or the project stays poisoned for the
      // life of the process.
      if (!result.ok) this.#open.delete(project)
      return result
    })
    this.#open.set(project, opening)
    return opening
  }

  async closeAll(): Promise<void> {
    const opening = [...this.#open.values()]
    this.#open.clear()
    // Await the in-flight opens first: a store still being opened would
    // otherwise leak its handles right past shutdown.
    for (const pending of opening) {
      const result = await pending.catch(() => null)
      if (result !== null && result.ok) await result.value.close()
    }
  }
}
