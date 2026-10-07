import { z } from 'zod'
import { createHash } from 'node:crypto'
import { defineTool } from '../../kernel/tool.js'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../../kernel/result.js'
import { normalizeTag } from '../../kernel/project.js'
import type { StoreRegistry } from '../../store/store.js'
import {
  DEFAULT_STALE_SECONDS,
  claimShape,
  timestamp,
  viewClaim,
  type Retraction,
} from './model.js'
import { readClaims, withEvidence, type ClaimSummary } from './projection.js'

const queryInput = z
  .object({
    project: z.string().min(1).describe('Project whose registry to read.'),
    text: z
      .string()
      .optional()
      .describe('Case-insensitive substring over statement. No ranking, no relevance.'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Conjunction: all of them must be present. Normalized as on assert.'),
    include_retracted: z.boolean().default(false).describe('Bring retracted claims too.'),
    only_retracted: z
      .boolean()
      .default(false)
      .describe('Only retracted claims. Takes precedence over include_retracted.'),
    observed_by: z.string().optional().describe('Exact match on the author.'),
    observed_after: timestamp('ISO 8601 lower bound on observed_at.').optional(),
    observed_before: timestamp('ISO 8601 upper bound on observed_at.').optional(),
    stale_seconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Threshold for the stale mark. Your threshold, not a judgement of ours. Defaults to the server's configured one (an hour unless set).",
      ),
    limit: z.number().int().min(1).max(500).default(50).describe('Page size.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque cursor from a previous page. Every page is cut from the registry as it stood at the first one, so claims written meanwhile never shift the window. Valid only with the filters and order it was issued for.',
      ),
    order: z
      .enum(['observed_desc', 'observed_asc', 'recorded_desc', 'recorded_asc'])
      .default('observed_desc')
      .describe('Sort order.'),
    evidence: z
      .enum(['none', 'ref', 'full'])
      .default('ref')
      .describe('How much evidence to include. `ref` keeps responses small.'),
  })
  .strict()

type QueryInput = z.infer<typeof queryInput>

const queryOutput = z
  .object({
    kind: z.literal('claims').describe('Discriminator of the result type.'),
    total_matched: z.number().describe('Exact count of claims matching the filter.'),
    claims: z.array(claimShape).describe('The page of claims, each with its own age.'),
    next_cursor: z.string().nullable().describe('Cursor for the next page, or null.'),
  })
  .strict()

/** facts.recall.query: filters, orders and pages claims. Never measures. */
export function createRecallQuery(stores: StoreRegistry, staleSeconds = DEFAULT_STALE_SECONDS) {
  return defineTool({
    name: 'recall.query',
    title: 'Query the registry',
    description:
      'Read claims from the project registry. It NEVER measures and opens no sockets: it returns what was recorded, each claim with its own age and stale mark, plus remeasure_with — the tool and arguments to measure it again yourself. Retracted claims are hidden unless asked for; they are never gone.',
    input: queryInput,
    output: queryOutput,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    target: (i) => ({
      stale_seconds: i.stale_seconds ?? staleSeconds,
      limit: i.limit,
      order: i.order,
      evidence: i.evidence,
      include_retracted: i.include_retracted,
      only_retracted: i.only_retracted,
      ...(i.text !== undefined ? { text: i.text } : {}),
      ...(i.tags !== undefined ? { tags: i.tags } : {}),
      ...(i.observed_by !== undefined ? { observed_by: i.observed_by } : {}),
      ...(i.observed_after !== undefined ? { observed_after: i.observed_after } : {}),
      ...(i.observed_before !== undefined ? { observed_before: i.observed_before } : {}),
      ...(i.cursor !== undefined ? { cursor: i.cursor } : {}),
    }),
    handler: async (i, ctx): Promise<Result<z.infer<typeof queryOutput>>> => {
      const store = await stores.get(ctx.project)
      if (!store.ok) return Err(store.error)

      // Normalized exactly as assert stores them: lowercasing alone would miss
      // `Orders API`, stored as `orders-api`.
      const wantedTags: string[] = []
      for (const t of i.tags ?? []) {
        const n = normalizeTag(t)
        if (!n.ok) return Err(n.error)
        wantedTags.push(n.value)
      }

      const hash = filterHash(i, wantedTags)
      let cursor: Cursor | null = null
      if (i.cursor !== undefined) {
        cursor = decodeCursor(i.cursor)
        // A cursor replayed under other filters would page through a different
        // result set from the wrong offset, and nothing would look wrong.
        if (cursor === null || cursor.f !== hash) {
          return Err(
            toolError(
              ErrorCodes.INVALID_INPUT,
              'the cursor was not issued for this query: pass the same filters and order, or start without one',
            ),
          )
        }
      }

      const { claims, lastSeq, warnings } = await readClaims(store.value)
      for (const w of warnings) ctx.warn(w)
      const snapshot = cursor?.s ?? lastSeq

      const matched = sortClaims(selectClaims(claims, snapshot, i, wantedTags), i.order)
      const start = cursor?.o ?? 0
      const end = start + i.limit
      const page = await withEvidence(store.value, matched.slice(start, end))
      const now = ctx.clock.now()
      const threshold = i.stale_seconds ?? staleSeconds

      return Ok({
        kind: 'claims' as const,
        total_matched: matched.length,
        claims: page.map((s) => viewClaim(s, ctx.project, now, threshold, i.evidence)),
        next_cursor:
          end < matched.length ? encodeCursor({ v: 1, o: end, s: snapshot, f: hash }) : null,
      })
    },
  })
}

/**
 * The claims a query selects, as the registry stood at event `snapshot`: one
 * asserted later does not exist yet, and one retracted later is not retracted
 * yet. The tools write one assert per claim, so these two are all a claim's
 * state can change by.
 */
function selectClaims(
  claims: ReadonlyMap<string, ClaimSummary>,
  snapshot: number,
  i: QueryInput,
  wantedTags: readonly string[],
): ClaimSummary[] {
  const keepRetraction = retentionTest(i)
  const filters = contentFilters(i, wantedTags)

  const selected: ClaimSummary[] = []
  for (const claim of claims.values()) {
    if (claim.assertSeq > snapshot) continue
    const retracted =
      claim.retractSeq !== null && claim.retractSeq <= snapshot ? claim.retracted : null
    if (!keepRetraction(retracted) || !filters.every((keep) => keep(claim))) continue
    selected.push(retracted === claim.retracted ? claim : { ...claim, retracted })
  }
  return selected
}

/** Standing claims only, by default; retracted ones too, or only those, when asked. */
function retentionTest(i: QueryInput): (retracted: Retraction | null) => boolean {
  if (i.only_retracted) return (retracted) => retracted !== null
  if (i.include_retracted) return () => true
  return (retracted) => retracted === null
}

/**
 * One test per filter the query sets. An unset filter is not a test that
 * always passes: it is absent, and costs nothing per claim.
 */
function contentFilters(
  i: QueryInput,
  wantedTags: readonly string[],
): ((claim: ClaimSummary) => boolean)[] {
  const filters: ((claim: ClaimSummary) => boolean)[] = []
  if (i.text !== undefined) {
    const needle = i.text.toLowerCase()
    filters.push((c) => c.statement.toLowerCase().includes(needle))
  }
  if (i.observed_by !== undefined) {
    const author = i.observed_by
    filters.push((c) => c.observed_by === author)
  }
  if (wantedTags.length > 0) filters.push((c) => wantedTags.every((t) => c.tags.includes(t)))
  // Bounds are inclusive. A claim whose time does not parse is not excluded
  // by a bound it cannot be compared with.
  if (i.observed_after !== undefined) {
    const after = Date.parse(i.observed_after)
    filters.push((c) => !(Date.parse(c.observed_at) < after))
  }
  if (i.observed_before !== undefined) {
    const before = Date.parse(i.observed_before)
    filters.push((c) => !(Date.parse(c.observed_at) > before))
  }
  return filters
}

/**
 * A total order: each timestamp parsed once rather than on every comparison,
 * and ties broken on claim_id — two claims written in the same millisecond
 * would otherwise land in an order that varies between calls, which a cursor
 * cannot page through reliably.
 */
function sortClaims(claims: ClaimSummary[], order: QueryInput['order']): ClaimSummary[] {
  const byObserved = order.startsWith('observed')
  const sign = order.endsWith('desc') ? -1 : 1
  return claims
    .map((claim) => ({
      at: Date.parse(byObserved ? claim.observed_at : claim.recorded_at) || 0,
      claim,
    }))
    .sort((a, b) => sign * (a.at - b.at) || sign * a.claim.claim_id.localeCompare(b.claim.claim_id))
    .map((x) => x.claim)
}

/**
 * A position in one query's results: offset `o` into the registry as it stood
 * at event `s`, for the filters hashed in `f`. Opaque to the caller.
 */
interface Cursor {
  readonly v: 1
  readonly o: number
  readonly s: number
  readonly f: string
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>
    const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
    if (c.v !== 1 || !count(c.o) || !count(c.s) || typeof c.f !== 'string') return null
    return c as Cursor
  } catch {
    return null
  }
}

/** Identifies what a query selects and in which order; not how it presents it. */
function filterHash(i: QueryInput, tags: readonly string[]): string {
  const selection = [
    i.text ?? null,
    [...tags].sort(),
    i.include_retracted,
    i.only_retracted,
    i.observed_by ?? null,
    i.observed_after ?? null,
    i.observed_before ?? null,
    i.order,
  ]
  return createHash('sha256').update(JSON.stringify(selection)).digest('base64url').slice(0, 16)
}
