import { z } from 'zod'
import { defineTool } from '../../kernel/tool.js'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../../kernel/result.js'
import { IdPrefix, newId } from '../../kernel/ulid.js'
import { normalizeTag } from '../../kernel/project.js'
import { toIsoWithOffset } from '../../kernel/clock.js'
import { redactText } from '../../kernel/redact.js'
import type { EvidenceRecord, StoreRegistry, StoredObservation } from '../../store/store.js'
import {
  DEFAULT_STALE_SECONDS,
  claimShape,
  timestamp,
  viewClaim,
  type ClaimState,
  type ClaimView,
} from './model.js'

const evidenceInput = z.union([
  z
    .object({
      type: z.literal('observation').describe('Evidence this server observed.'),
      observation_id: z.string().min(1).describe('Id returned by a measure.* call.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('external').describe('Evidence this server did not take.'),
      description: z.string().min(1).max(1000).describe('What the evidence is.'),
      uri: z.string().optional().describe('Where it lives, if anywhere.'),
    })
    .strict(),
])

const assertInput = z
  .object({
    project: z.string().min(1).describe('Project whose registry to write to.'),
    statement: z
      .string()
      .min(1)
      .max(2000)
      .describe('The claim. Free text: it is never parsed, validated or interpreted.'),
    evidence: z
      .array(evidenceInput)
      .min(1)
      .describe('At least one piece of evidence. A claim without evidence does not go in.'),
    observed_by: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Who observed it. Mandatory, no default: a claim without an author does not go in.',
      ),
    observed_at: timestamp(
      'When it was observed. Required with external evidence; forbidden when all evidence is this server’s own, where it is derived.',
    ).optional(),
    tags: z.array(z.string()).max(20).default([]).describe('Tags, normalized like a project.'),
  })
  .strict()

type AssertInput = z.infer<typeof assertInput>

/** facts.recall.assert: writes a claim with its evidence embedded. */
export function createRecallAssert(stores: StoreRegistry, staleSeconds = DEFAULT_STALE_SECONDS) {
  return defineTool({
    name: 'recall.assert',
    title: 'Assert a claim',
    description:
      'Write a claim into the project registry: statement, evidence, who observed it and when. It does NOT measure anything and it does NOT check that the evidence supports the statement — that would be interpreting. It checks only that the evidence exists and belongs to this project, and embeds it so the claim stays auditable.',
    input: assertInput,
    output: claimShape,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    target: (i) => ({
      statement: i.statement,
      evidence: i.evidence,
      observed_by: i.observed_by,
      tags: i.tags,
      ...(i.observed_at !== undefined ? { observed_at: i.observed_at } : {}),
    }),
    handler: async (i, ctx): Promise<Result<ClaimView>> => {
      const store = await stores.get(ctx.project)
      if (!store.ok) return Err(store.error)

      const timing = checkObservedAt(i)
      if (!timing.ok) return timing

      // Each cited observation is read straight from its line.
      const { found: cited, warnings } = await store.value.findObservations(
        i.evidence.flatMap((e) => (e.type === 'observation' ? [e.observation_id] : [])),
      )
      for (const w of warnings) ctx.warn(w)
      const evidence = embedEvidence(i.evidence, cited, ctx.project)
      if (!evidence.ok) return evidence
      const { records, observedTimes } = evidence.value

      const tags: string[] = []
      for (const t of i.tags) {
        const n = normalizeTag(t)
        if (!n.ok) return Err(n.error)
        tags.push(n.value)
      }

      const observedAt =
        i.observed_at ??
        (observedTimes.length > 0
          ? toIsoWithOffset(new Date(Math.min(...observedTimes)))
          : toIsoWithOffset(ctx.clock.now()))

      const claimId = newId(IdPrefix.claim)
      const state: ClaimState = {
        claim_id: claimId,
        statement: redactText(i.statement),
        evidence: records,
        observed_by: redactText(i.observed_by),
        observed_at: observedAt,
        recorded_at: toIsoWithOffset(ctx.clock.now()),
        tags,
        retracted: null,
      }
      const { retracted: _none, ...body } = state
      const written = await store.value.claims.append('assert', claimId, body)
      if (!written.ok) return Err(written.error)

      // The response is built from what was written, so the two cannot differ.
      return Ok(viewClaim(state, ctx.project, ctx.clock.now(), staleSeconds, 'full'))
    },
  })
}

/**
 * The evidence as the claim will carry it, and the times of the observations
 * it cites.
 *
 * Everything the caller typed is redacted before it is written, never after: a
 * token pasted into an evidence URI would otherwise sit in the append-only log
 * for good. Observation snapshots need nothing more; they were redacted when
 * they were observed.
 */
function embedEvidence(
  evidence: AssertInput['evidence'],
  cited: ReadonlyMap<string, StoredObservation>,
  project: string,
): Result<{ records: EvidenceRecord[]; observedTimes: number[] }> {
  const records: EvidenceRecord[] = []
  const observedTimes: number[] = []
  for (const e of evidence) {
    if (e.type === 'external') {
      records.push({
        type: 'external',
        description: redactText(e.description),
        ...(e.uri !== undefined ? { uri: redactText(e.uri) } : {}),
      })
      continue
    }
    const found = cited.get(e.observation_id)
    if (found === undefined) {
      // Same error whether it never existed or belongs to another project: not
      // leaking existence across projects is the point.
      return Err(
        toolError(
          ErrorCodes.OBSERVATION_NOT_FOUND,
          `no observation ${e.observation_id} in project ${project}`,
          { detail: { observation_id: e.observation_id, project } },
        ),
      )
    }
    records.push({
      type: 'observation',
      observation_id: e.observation_id,
      // Exactly the snapshot's fields: whatever else the stored line holds is
      // not part of what the claim cites.
      snapshot: {
        tool: found.tool,
        target: found.target,
        observed_at: found.observed_at,
        ok: found.ok,
        data: found.data,
      },
    })
    const t = Date.parse(found.observed_at)
    if (!Number.isNaN(t)) observedTimes.push(t)
  }
  return Ok({ records, observedTimes })
}

/**
 * observed_at is the caller's to give only when some evidence is external: for
 * this server's own observations it is derived, and a caller's value could only
 * contradict what was measured.
 */
function checkObservedAt(i: AssertInput): Result<void> {
  const hasExternal = i.evidence.some((e) => e.type === 'external')
  if (!hasExternal && i.observed_at !== undefined) {
    return Err(
      toolError(
        ErrorCodes.OBSERVED_AT_NOT_ALLOWED,
        'observed_at is derived from the cited observations and cannot be set when all evidence is this server’s own',
      ),
    )
  }
  if (hasExternal && i.observed_at === undefined) {
    return Err(
      toolError(
        ErrorCodes.OBSERVED_AT_REQUIRED,
        'observed_at is required when any evidence is external',
      ),
    )
  }
  return Ok(undefined)
}
