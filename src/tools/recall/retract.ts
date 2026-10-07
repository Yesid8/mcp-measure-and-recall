import { z } from 'zod'
import { defineTool } from '../../kernel/tool.js'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../../kernel/result.js'
import { toIsoWithOffset } from '../../kernel/clock.js'
import { redactText } from '../../kernel/redact.js'
import type { StoreRegistry } from '../../store/store.js'
import {
  DEFAULT_STALE_SECONDS,
  claimNotFound,
  claimShape,
  findSupersedeCycle,
  reduceClaim,
  viewClaim,
  type ClaimView,
} from './model.js'
import { readClaims, withEvidence, type ClaimSummary } from './projection.js'

const retractInput = z
  .object({
    project: z.string().min(1).describe('Project whose registry to write to.'),
    claim_id: z.string().min(1).describe('The claim to mark as retracted.'),
    reason: z
      .string()
      .min(1)
      .max(1000)
      .describe('Why it is being retracted. Without a reason there is no retraction.'),
    by: z.string().min(1).max(200).describe('Who is retracting it.'),
    superseded_by: z
      .string()
      .optional()
      .describe('Claim id that replaces it. Must exist in the same project.'),
  })
  .strict()

/** facts.recall.retract: appends a retraction; the claim itself stays. */
export function createRecallRetract(stores: StoreRegistry, staleSeconds = DEFAULT_STALE_SECONDS) {
  return defineTool({
    name: 'recall.retract',
    title: 'Retract a claim',
    description:
      'Mark a claim as retracted, with a reason and an author. The claim is NEVER deleted: the original line stays byte for byte and the retraction is a new event. There is no delete tool and no parameter that removes anything.',
    input: retractInput,
    output: claimShape,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    target: (i) => ({
      claim_id: i.claim_id,
      reason: i.reason,
      by: i.by,
      ...(i.superseded_by !== undefined ? { superseded_by: i.superseded_by } : {}),
    }),
    handler: async (i, ctx): Promise<Result<ClaimView>> => {
      const store = await stores.get(ctx.project)
      if (!store.ok) return Err(store.error)

      const { claims, warnings } = await readClaims(store.value)
      for (const w of warnings) ctx.warn(w)

      const summary = claims.get(i.claim_id)
      if (summary === undefined) return Err(claimNotFound(i.claim_id, ctx.project))
      const refused = checkRetractable(summary, i.superseded_by, claims, ctx.project)
      if (!refused.ok) return refused

      // Redacted before it is written, like everything a caller types.
      const retraction = {
        at: toIsoWithOffset(ctx.clock.now()),
        by: redactText(i.by),
        reason: redactText(i.reason),
        superseded_by: i.superseded_by ?? null,
      }
      // Re-check inside the write queue: the state read above is already stale
      // by the time we get here, and a concurrent retraction would otherwise
      // add a second line saying the same thing with a different reason.
      const written = await store.value.claims.appendIf(
        [{ op: 'retract', key: i.claim_id, body: retraction }],
        i.claim_id,
        (history) => {
          const current = reduceClaim(history)
          if (current === null) return Err(claimNotFound(i.claim_id, ctx.project))
          if (current.retracted !== null) return alreadyRetracted(i.claim_id, current.retracted)
          return Ok(undefined)
        },
      )
      if (!written.ok) return Err(written.error)

      const [state] = await withEvidence(store.value, [summary])
      return Ok(
        viewClaim(
          { ...state!, retracted: retraction },
          ctx.project,
          ctx.clock.now(),
          staleSeconds,
          'ref',
        ),
      )
    },
  })
}

/**
 * Why a claim cannot be retracted as asked, if it cannot: retracted already —
 * a second line would add noise without adding truth — or a replacement that
 * does not exist or would close a supersede cycle.
 */
function checkRetractable(
  summary: ClaimSummary,
  supersededBy: string | undefined,
  claims: ReadonlyMap<string, ClaimSummary>,
  project: string,
): Result<void> {
  if (summary.retracted !== null) return alreadyRetracted(summary.claim_id, summary.retracted)
  if (supersededBy === undefined) return Ok(undefined)
  if (supersededBy === summary.claim_id) {
    return Err(toolError(ErrorCodes.CIRCULAR_SUPERSEDE, 'a claim cannot supersede itself'))
  }
  if (!claims.has(supersededBy)) return Err(claimNotFound(supersededBy, project))
  const cycle = findSupersedeCycle(
    (id) => claims.get(id)?.retracted,
    summary.claim_id,
    supersededBy,
  )
  if (cycle !== null) {
    return Err(
      toolError(ErrorCodes.CIRCULAR_SUPERSEDE, 'superseded_by would close a cycle', {
        detail: { at: cycle },
      }),
    )
  }
  return Ok(undefined)
}

function alreadyRetracted(claimId: string, retracted: unknown): Result<never> {
  return Err(
    toolError(ErrorCodes.ALREADY_RETRACTED, `claim ${claimId} was already retracted`, {
      detail: { retracted },
    }),
  )
}
