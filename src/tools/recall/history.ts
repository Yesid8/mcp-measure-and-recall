import { z } from 'zod'
import { defineTool } from '../../kernel/tool.js'
import { Err, Ok, type Result } from '../../kernel/result.js'
import type { StoreRegistry } from '../../store/store.js'
import {
  DEFAULT_STALE_SECONDS,
  claimNotFound,
  claimShape,
  reduceClaim,
  viewClaim,
} from './model.js'

const historyInput = z
  .object({
    project: z.string().min(1).describe('Project whose registry to read.'),
    claim_id: z.string().min(1).describe('The claim whose events to return.'),
  })
  .strict()

const historyOutput = z
  .object({
    kind: z.literal('history').describe('Discriminator of the result type.'),
    claim_id: z.string().describe('The claim these events belong to.'),
    events: z
      .array(
        z.object({
          seq: z.number().describe('Position in the log.'),
          at: z.string().describe('When the event was written.'),
          op: z.string().describe('assert or retract.'),
          body: z.unknown().describe('The event payload, verbatim.'),
        }),
      )
      .describe('The raw events, in order. The auditable guarantee that nothing was rewritten.'),
    current: z.union([claimShape, z.null()]).describe('The state these events reduce to.'),
  })
  .strict()

/** facts.recall.history: the raw events of one claim, as they sit in the log. */
export function createRecallHistory(stores: StoreRegistry, staleSeconds = DEFAULT_STALE_SECONDS) {
  return defineTool({
    name: 'recall.history',
    title: 'Claim history',
    description:
      'Return the raw events of one claim, in order, exactly as they sit in the log. This is the auditable proof that nothing was rewritten: an assert, then a retract if there was one.',
    input: historyInput,
    output: historyOutput,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    target: (i) => ({ claim_id: i.claim_id }),
    handler: async (i, ctx): Promise<Result<z.infer<typeof historyOutput>>> => {
      const store = await stores.get(ctx.project)
      if (!store.ok) return Err(store.error)

      const { events, warnings } = await store.value.claims.history(i.claim_id)
      for (const w of warnings) ctx.warn(w)
      if (events.length === 0) return Err(claimNotFound(i.claim_id, ctx.project))

      const state = reduceClaim(events)
      return Ok({
        kind: 'history' as const,
        claim_id: i.claim_id,
        events: events.map((e) => ({ seq: e.seq, at: e.at, op: e.op, body: e.body })),
        current:
          state === null
            ? null
            : viewClaim(state, ctx.project, ctx.clock.now(), staleSeconds, 'ref'),
      })
    },
  })
}
