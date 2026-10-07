import type { Warning } from '../../kernel/envelope.js'
import type { EventLog, Locator, LogView, LoggedEvent } from '../../store/event-log.js'
import type { ClaimBody, ProjectStore } from '../../store/store.js'
import { assertedState, retractionOf, type ClaimState } from './model.js'

/**
 * Every claim's current state, kept in memory beside the log.
 *
 * Everything but the evidence: a claim citing an observation embeds the whole
 * snapshot, response body included, and keeping those in memory would cost as
 * much as the file. What a query filters and sorts on lives here; the evidence
 * stays on disk and is read for the page actually returned.
 */

/** A claim's state without its evidence, plus where to find the rest. */
export interface ClaimSummary extends Omit<ClaimState, 'evidence'> {
  /** The event that asserted it, and where its line sits in the file. */
  readonly assertSeq: number
  readonly assertAt: Locator
  /** The event that retracted it, if any. */
  readonly retractSeq: number | null
}

class ClaimProjection implements LogView<ClaimBody> {
  readonly claims = new Map<string, ClaimSummary>()
  lastSeq = 0

  reset(): void {
    this.claims.clear()
    this.lastSeq = 0
  }

  apply(event: LoggedEvent<ClaimBody>, at: Locator): void {
    this.lastSeq = Math.max(this.lastSeq, event.seq)
    if (event.op === 'assert') {
      const { evidence: _onDisk, ...state } = assertedState(event.body)
      this.claims.set(event.key, { ...state, assertSeq: event.seq, assertAt: at, retractSeq: null })
      return
    }
    // A retraction of a claim that does not exist changes nothing, as in the fold.
    const prior = this.claims.get(event.key)
    if (event.op === 'retract' && prior !== undefined) {
      this.claims.set(event.key, {
        ...prior,
        retracted: retractionOf(event.body),
        retractSeq: event.seq,
      })
    }
  }
}

const projections = new WeakMap<EventLog<ClaimBody>, ClaimProjection>()

/**
 * The claims of a project, current with its log, and the damage the log
 * holds — which every read must report. The first call pays one pass over
 * the file; later ones only what was appended since.
 */
export async function readClaims(store: ProjectStore): Promise<{
  claims: ReadonlyMap<string, ClaimSummary>
  lastSeq: number
  warnings: readonly Warning[]
}> {
  let projection = projections.get(store.claims)
  if (projection === undefined) {
    projection = new ClaimProjection()
    store.claims.attach(projection)
    projections.set(store.claims, projection)
  }
  const warnings = await store.claims.refresh()
  return { claims: projection.claims, lastSeq: projection.lastSeq, warnings }
}

/**
 * The full states of these claims, as they stood when `summaries` was read:
 * the evidence comes from each one's assert line, everything else from the
 * summary — which carries its retraction, if it has one.
 */
export async function withEvidence(
  store: ProjectStore,
  summaries: readonly ClaimSummary[],
): Promise<ClaimState[]> {
  const asserts = await store.claims.read(summaries.map((s) => s.assertAt))
  return summaries.map((s, n) => {
    const { assertSeq: _seq, assertAt: _at, retractSeq: _retractSeq, ...state } = s
    return { ...state, evidence: asserts[n]?.body.evidence ?? [] }
  })
}
