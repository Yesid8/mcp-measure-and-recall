import { z } from 'zod'
import { ErrorCodes, toolError, type ToolError } from '../../kernel/result.js'
import { wallAge } from '../../kernel/envelope.js'
import type { ClaimBody, EvidenceRecord } from '../../store/store.js'
import { remeasureWith } from './remeasure.js'

/**
 * What a claim is, and how its state follows from its events.
 *
 * Shared by the four recall.* tools. None of them measure and none delete:
 * a claim is an `assert` event, possibly followed by a `retract`, and its
 * current state is a fold over them — never stored, always derived.
 */

/**
 * Default freshness threshold, in seconds.
 *
 * An hour is not a claim about how long anything stays true — that is the
 * caller's judgement, and recall.query takes it as a parameter. It is the
 * default for the responses that have no caller-supplied threshold, chosen so
 * that a claim made in the same working session does not read as stale.
 */
export const DEFAULT_STALE_SECONDS = 3600

/**
 * An ISO 8601 timestamp that actually parses.
 *
 * Checked in the schema rather than in each handler, because an unparseable
 * time fails silently wherever it lands: asserted, it enters the append-only
 * log reading as age 0; as a filter bound, it matches everything.
 */
export const timestamp = (description: string) =>
  z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: 'not a parseable ISO 8601 timestamp',
    })
    .describe(description)

export const claimShape = z.object({
  claim_id: z.string().describe('Opaque id of the claim.'),
  statement: z.string().describe('The claim, verbatim. Never parsed or interpreted.'),
  evidence: z.array(z.unknown()).describe('What backs it.'),
  observed_by: z.string().describe('Who made the observation.'),
  observed_at: z.string().describe('When what it asserts was observed.'),
  age_seconds: z.number().describe('Age of THIS claim, not of the query.'),
  age_basis: z.enum(['monotonic', 'wall']).describe('Which clock the age came from.'),
  stale: z.boolean().describe('Arithmetic: age_seconds > stale_seconds. Not a judgement.'),
  recorded_at: z.string().describe('When it was written down.'),
  tags: z.array(z.string()).describe('Normalized tags.'),
  retracted: z
    .union([
      z.object({
        at: z.string().describe('When it was retracted.'),
        by: z.string().describe('Who retracted it.'),
        reason: z.string().describe('Why, as given.'),
        superseded_by: z.string().nullable().describe('The claim that replaces it, if any.'),
      }),
      z.null(),
    ])
    .describe('Null, or why and by whom it was retracted. Retracted is never deleted.'),
  remeasure_with: z
    .union([
      z.object({
        tool: z.string().describe('The tool that took the evidence.'),
        arguments: z
          .record(z.string(), z.unknown())
          .describe('The arguments it was taken with, minus anything that was redacted.'),
        omitted: z
          .array(z.string())
          .describe(
            'Arguments left out because they carried credentials, e.g. headers.authorization or url.query.token. Supply your own to re-measure.',
          ),
      }),
      z.null(),
    ])
    .describe('How to measure this again. Present when the evidence is an observation.'),
})

export type ClaimView = z.infer<typeof claimShape>

export interface Retraction {
  readonly at: string
  readonly by: string
  readonly reason: string
  readonly superseded_by: string | null
}

/** A claim's current state: the fold of its events. */
export interface ClaimState {
  readonly claim_id: string
  readonly statement: string
  readonly evidence: readonly EvidenceRecord[]
  readonly observed_by: string
  readonly observed_at: string
  readonly recorded_at: string
  readonly tags: readonly string[]
  readonly retracted: Retraction | null
}

/** The event shape the fold reads: the log stores bodies without knowing their op. */
export interface ClaimEvent {
  readonly op: string
  readonly body: ClaimBody
}

/** The state an `assert` body establishes. */
export function assertedState(body: ClaimBody): ClaimState {
  return {
    claim_id: body.claim_id ?? '',
    statement: body.statement ?? '',
    evidence: body.evidence ?? [],
    observed_by: body.observed_by ?? '',
    observed_at: body.observed_at ?? '',
    recorded_at: body.recorded_at ?? '',
    tags: body.tags ?? [],
    retracted: null,
  }
}

/** The retraction a `retract` body records. */
export function retractionOf(body: ClaimBody): Retraction {
  return {
    at: body.at ?? '',
    by: body.by ?? '',
    reason: body.reason ?? '',
    superseded_by: body.superseded_by ?? null,
  }
}

/** One step of the fold. An event for an unknown op leaves the state untouched. */
export function applyClaimEvent(prior: ClaimState | null, e: ClaimEvent): ClaimState | null {
  if (e.op === 'assert') return assertedState(e.body)
  if (e.op === 'retract' && prior !== null) return { ...prior, retracted: retractionOf(e.body) }
  return prior
}

/** Replays one key's events in order. */
export function reduceClaim(events: readonly ClaimEvent[]): ClaimState | null {
  let state: ClaimState | null = null
  for (const e of events) state = applyClaimEvent(state, e)
  return state
}

/** The same error whether the claim never existed or belongs to another project. */
export function claimNotFound(claimId: string, project: string): ToolError {
  return toolError(ErrorCodes.CLAIM_NOT_FOUND, `no claim ${claimId} in project ${project}`, {
    detail: { claim_id: claimId, project },
  })
}

/**
 * Follows the supersede chain from `start`, returning the id where it closes
 * back on itself or on `origin`, or null if it terminates.
 *
 * The visited set is what keeps a malformed chain from looping forever; without
 * it a cycle already in the log would hang the call rather than fail it.
 */
export function findSupersedeCycle(
  retractions: (claimId: string) => Retraction | null | undefined,
  origin: string,
  start: string,
): string | null {
  const seen = new Set<string>([origin])
  let cursor: string | null = start
  while (cursor !== null) {
    if (seen.has(cursor)) return cursor
    seen.add(cursor)
    cursor = retractions(cursor)?.superseded_by ?? null
  }
  return null
}

/** How much evidence a view carries. `ref` names each observation without embedding it. */
export type EvidenceMode = 'none' | 'ref' | 'full'

/** A claim as a caller sees it: with its own age, its stale mark and how to re-measure it. */
export function viewClaim(
  state: ClaimState,
  project: string,
  now: Date,
  staleSeconds: number,
  evidenceMode: EvidenceMode,
): ClaimView {
  const { age_seconds, age_basis } = wallAge(state.observed_at, now)
  return {
    claim_id: state.claim_id,
    statement: state.statement,
    evidence: evidenceView(state.evidence, evidenceMode),
    observed_by: state.observed_by,
    observed_at: state.observed_at,
    age_seconds,
    age_basis,
    stale: age_seconds > staleSeconds,
    recorded_at: state.recorded_at,
    tags: [...state.tags],
    retracted: state.retracted,
    remeasure_with: remeasureWith(state.evidence, project),
  }
}

function evidenceView(evidence: readonly EvidenceRecord[], mode: EvidenceMode): unknown[] {
  if (mode === 'none') return []
  if (mode === 'full') return [...evidence]
  return evidence.map((e) =>
    e.type === 'observation'
      ? {
          type: 'observation',
          observation_id: e.observation_id,
          ref: { tool: e.snapshot.tool, observed_at: e.snapshot.observed_at },
        }
      : e,
  )
}
