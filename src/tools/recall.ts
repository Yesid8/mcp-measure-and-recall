import { z } from 'zod'
import { createHash } from 'node:crypto'
import { defineTool } from '../kernel/tool.js'
import { CoreErrors, Err, Ok, toolError, type Result } from '../kernel/result.js'
import { wallAge, type Warning } from '../kernel/envelope.js'
import { IdPrefix, newId } from '../kernel/ulid.js'
import { normalizeTag } from '../kernel/project.js'
import { toIsoWithOffset } from '../kernel/clock.js'
import { containsRedaction, redactText } from '../kernel/redact.js'
import type { StoreRegistry, ClaimBody, EvidenceRecord, ProjectStore } from '../store/store.js'

/**
 * The recall.* family.
 *
 * None of these measure. None of these delete. Rule F1 is mechanical here:
 * a query returns each claim with its own age and, when the evidence is an
 * observation this server took, `remeasure_with` — the exact tool and arguments
 * to take it again. The registry hands you the way to re-measure instead of
 * pretending it knows the current state.
 */

/**
 * An ISO 8601 timestamp that actually parses.
 *
 * Checked in the schema rather than in each handler, because an unparseable
 * time fails silently wherever it lands: asserted, it enters the append-only
 * log reading as age 0; as a filter bound, it matches everything.
 */
const timestamp = (description: string) =>
  z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: 'not a parseable ISO 8601 timestamp',
    })
    .describe(description)

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

const claimShape = z.object({
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

interface ClaimState {
  claim_id: string
  statement: string
  evidence: readonly EvidenceRecord[]
  observed_by: string
  observed_at: string
  recorded_at: string
  tags: readonly string[]
  retracted: { at: string; by: string; reason: string; superseded_by: string | null } | null
}

/**
 * Default freshness threshold, in seconds.
 *
 * An hour is not a claim about how long anything stays true — that is the
 * caller's judgement, and recall.query takes it as a parameter. It is the
 * default for the responses that have no caller-supplied threshold, chosen so
 * that a claim made in the same working session does not read as stale.
 */
export const DEFAULT_STALE_SECONDS = 3600

type ClaimEvent = { readonly op: string; readonly body: ClaimBody }

/** One step of the fold. An event for an unknown op leaves the state untouched. */
function applyClaimEvent(prior: ClaimState | null, e: ClaimEvent): ClaimState | null {
  if (e.op === 'assert') {
    return {
      claim_id: e.body.claim_id ?? '',
      statement: e.body.statement ?? '',
      evidence: e.body.evidence ?? [],
      observed_by: e.body.observed_by ?? '',
      observed_at: e.body.observed_at ?? '',
      recorded_at: e.body.recorded_at ?? '',
      tags: e.body.tags ?? [],
      retracted: null,
    }
  }
  if (e.op === 'retract' && prior !== null) {
    return {
      ...prior,
      retracted: {
        at: e.body.at ?? '',
        by: e.body.by ?? '',
        reason: e.body.reason ?? '',
        superseded_by: e.body.superseded_by ?? null,
      },
    }
  }
  return prior
}

/** Replays one key's events in order. The state is a projection, never stored. */
function reduceClaim(events: readonly ClaimEvent[]): ClaimState | null {
  let state: ClaimState | null = null
  for (const e of events) state = applyClaimEvent(state, e)
  return state
}

type RemeasureWith = NonNullable<ClaimView['remeasure_with']>

/** Whether any string inside `value` carries a redaction marker. */
function hasRedaction(value: unknown): boolean {
  return containsRedaction(JSON.stringify(value) ?? '')
}

/**
 * A redacted URL made replayable: userinfo and redacted query parameters
 * removed, the rest kept. Null when a marker remains anywhere else.
 */
function replayableUrl(raw: string): { url: string; omitted: string[] } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const omitted: string[] = []
  if (url.username !== '' || url.password !== '') {
    url.username = ''
    url.password = ''
    omitted.push('url.userinfo')
  }
  // Collected first and deleted after: deleting while iterating the live
  // URLSearchParams would skip the entry that follows each deletion.
  const redactedNames = new Set<string>()
  for (const [name, value] of url.searchParams) {
    if (containsRedaction(value)) redactedNames.add(name)
  }
  for (const name of redactedNames) {
    url.searchParams.delete(name)
    omitted.push(`url.query.${name}`)
  }
  const out = url.toString()
  return containsRedaction(decodeURIComponent(out)) ? null : { url: out, omitted }
}

/**
 * Builds remeasure_with from the first cited observation.
 *
 * These arguments are meant to be replayed, and a redaction marker replayed as
 * a header, a URL or a body is a broken request that looks valid — worse than
 * an absent argument. So anything redacted is left out, at the finest grain
 * that keeps the rest usable, and named in `omitted` for the caller to supply.
 */
function remeasureWith(evidence: readonly EvidenceRecord[], project: string): RemeasureWith | null {
  const first = evidence.find((e) => e.type === 'observation')
  if (first === undefined || first.type !== 'observation') return null

  const args: Record<string, unknown> = {}
  const omitted: string[] = []
  for (const [key, value] of Object.entries(first.snapshot.target)) {
    if (!hasRedaction(value)) {
      args[key] = value
    } else if (key === 'url' && typeof value === 'string') {
      const replayable = replayableUrl(value)
      if (replayable === null) {
        omitted.push('url')
      } else {
        args[key] = replayable.url
        omitted.push(...replayable.omitted)
      }
    } else if (Array.isArray(value)) {
      args[key] = value.filter((item, n) => {
        if (!hasRedaction(item)) return true
        omitted.push(`${key}[${n}]`)
        return false
      })
    } else if (value !== null && typeof value === 'object') {
      const kept: Record<string, unknown> = {}
      for (const [name, v] of Object.entries(value)) {
        if (hasRedaction(v)) omitted.push(`${key}.${name}`)
        else kept[name] = v
      }
      if (Object.keys(kept).length > 0) args[key] = kept
    } else {
      omitted.push(key)
    }
  }
  return { tool: first.snapshot.tool, arguments: { project, ...args }, omitted }
}

function viewClaim(
  state: ClaimState,
  project: string,
  now: Date,
  staleSeconds: number,
  evidenceMode: 'none' | 'ref' | 'full',
): ClaimView {
  const { age_seconds, age_basis } = wallAge(state.observed_at, now)
  const evidence =
    evidenceMode === 'none'
      ? []
      : evidenceMode === 'full'
        ? [...state.evidence]
        : state.evidence.map((e) =>
            e.type === 'observation'
              ? {
                  type: 'observation',
                  observation_id: e.observation_id,
                  ref: { tool: e.snapshot.tool, observed_at: e.snapshot.observed_at },
                }
              : e,
          )
  return {
    claim_id: state.claim_id,
    statement: state.statement,
    evidence,
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

/**
 * Every claim's state, keyed by id, from a single pass over the log.
 *
 * With `uptoSeq`, the state as it was when that event was the last one: the
 * snapshot a paginated query keeps reading from. `lastSeq` is the newest event
 * seen, whatever the bound.
 */
async function allClaims(
  store: ProjectStore,
  uptoSeq = Number.POSITIVE_INFINITY,
): Promise<{
  states: Map<string, ClaimState>
  lastSeq: number
  warnings: readonly Warning[]
}> {
  const { events, warnings } = await store.claims.scan()
  // Events arrive in sequence order, so folding them as they come gives the
  // same result as grouping first, without the intermediate map of arrays.
  const states = new Map<string, ClaimState>()
  let lastSeq = 0
  for (const e of events) {
    lastSeq = Math.max(lastSeq, e.seq)
    if (e.seq > uptoSeq) continue
    const next = applyClaimEvent(states.get(e.key) ?? null, e)
    if (next !== null) states.set(e.key, next)
  }
  return { states, lastSeq, warnings }
}

/**
 * Follows the supersede chain from `start`, returning the id where it closes
 * back on itself or on `origin`, or null if it terminates.
 *
 * The visited set is what keeps a malformed chain from looping forever; without
 * it a cycle already in the log would hang the call rather than fail it.
 */
function findSupersedeCycle(
  states: ReadonlyMap<string, ClaimState>,
  origin: string,
  start: string,
): string | null {
  const seen = new Set<string>([origin])
  let cursor: string | null = start
  while (cursor !== null) {
    if (seen.has(cursor)) return cursor
    seen.add(cursor)
    cursor = states.get(cursor)?.retracted?.superseded_by ?? null
  }
  return null
}

// ── recall.assert ───────────────────────────────────────────────────────────

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

      const hasExternal = i.evidence.some((e) => e.type === 'external')
      if (!hasExternal && i.observed_at !== undefined) {
        return Err(
          toolError(
            'OBSERVED_AT_NOT_ALLOWED',
            'observed_at is derived from the cited observations and cannot be set when all evidence is this server’s own',
          ),
        )
      }
      if (hasExternal && i.observed_at === undefined) {
        return Err(
          toolError(
            'OBSERVED_AT_REQUIRED',
            'observed_at is required when any evidence is external',
          ),
        )
      }
      // One pass over the log resolves every citation.
      const { found: cited, warnings } = await store.value.findObservations(
        i.evidence.flatMap((e) => (e.type === 'observation' ? [e.observation_id] : [])),
      )
      for (const w of warnings) ctx.warn(w)

      const records: EvidenceRecord[] = []
      const observedTimes: number[] = []
      for (const e of i.evidence) {
        // Everything the caller typed is redacted before it is written, never
        // after: a token pasted into a statement or an evidence URI would
        // otherwise sit in the append-only log for good. Observation snapshots
        // need nothing more; they were redacted when they were observed.
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
          // Same error whether it never existed or belongs to another project:
          // not leaking existence across projects is the point.
          return Err(
            toolError(
              'OBSERVATION_NOT_FOUND',
              `no observation ${e.observation_id} in project ${ctx.project}`,
              { detail: { observation_id: e.observation_id, project: ctx.project } },
            ),
          )
        }
        records.push({
          type: 'observation',
          observation_id: e.observation_id,
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

// ── recall.retract ──────────────────────────────────────────────────────────

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

      // Walking a supersede chain one history() call per link re-reads the file
      // per link; one pass gives every state the walk can need.
      const { states, warnings } = await allClaims(store.value)
      for (const w of warnings) ctx.warn(w)

      const state = states.get(i.claim_id)
      if (state === undefined) {
        return Err(
          toolError('CLAIM_NOT_FOUND', `no claim ${i.claim_id} in project ${ctx.project}`, {
            detail: { claim_id: i.claim_id, project: ctx.project },
          }),
        )
      }
      if (state.retracted !== null) {
        // Already retracted: report it and write nothing. A second line would
        // add noise without adding truth.
        return Err(
          toolError('ALREADY_RETRACTED', `claim ${i.claim_id} was already retracted`, {
            detail: { retracted: state.retracted },
          }),
        )
      }

      if (i.superseded_by !== undefined) {
        if (i.superseded_by === i.claim_id) {
          return Err(toolError('CIRCULAR_SUPERSEDE', 'a claim cannot supersede itself'))
        }
        if (!states.has(i.superseded_by)) {
          return Err(
            toolError('CLAIM_NOT_FOUND', `no claim ${i.superseded_by} in project ${ctx.project}`),
          )
        }
        const cycle = findSupersedeCycle(states, i.claim_id, i.superseded_by)
        if (cycle !== null) {
          return Err(
            toolError('CIRCULAR_SUPERSEDE', 'superseded_by would close a cycle', {
              detail: { at: cycle },
            }),
          )
        }
      }

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
          if (current === null) {
            return Err(
              toolError('CLAIM_NOT_FOUND', `no claim ${i.claim_id} in project ${ctx.project}`),
            )
          }
          if (current.retracted !== null) {
            return Err(
              toolError('ALREADY_RETRACTED', `claim ${i.claim_id} was already retracted`, {
                detail: { retracted: current.retracted },
              }),
            )
          }
          return Ok(undefined)
        },
      )
      if (!written.ok) return Err(written.error)

      const retracted: ClaimState = { ...state, retracted: retraction }
      return Ok(viewClaim(retracted, ctx.project, ctx.clock.now(), staleSeconds, 'ref'))
    },
  })
}

// ── recall.query ────────────────────────────────────────────────────────────

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

const queryOutput = z
  .object({
    kind: z.literal('claims').describe('Discriminator of the result type.'),
    total_matched: z.number().describe('Exact count of claims matching the filter.'),
    claims: z.array(claimShape).describe('The page of claims, each with its own age.'),
    next_cursor: z.string().nullable().describe('Cursor for the next page, or null.'),
  })
  .strict()

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
function filterHash(i: z.infer<typeof queryInput>, tags: readonly string[]): string {
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
              CoreErrors.INVALID_INPUT,
              'the cursor was not issued for this query: pass the same filters and order, or start without one',
            ),
          )
        }
      }

      const { states, lastSeq, warnings } = await allClaims(
        store.value,
        cursor?.s ?? Number.POSITIVE_INFINITY,
      )
      for (const w of warnings) ctx.warn(w)
      const snapshot = cursor?.s ?? lastSeq

      const needle = i.text?.toLowerCase()
      const after = i.observed_after === undefined ? null : Date.parse(i.observed_after)
      const before = i.observed_before === undefined ? null : Date.parse(i.observed_before)

      let matched = [...states.values()].filter((s) => {
        if (i.only_retracted && s.retracted === null) return false
        if (!i.only_retracted && !i.include_retracted && s.retracted !== null) return false
        if (needle !== undefined && !s.statement.toLowerCase().includes(needle)) return false
        if (i.observed_by !== undefined && s.observed_by !== i.observed_by) return false
        if (!wantedTags.every((t) => s.tags.includes(t))) return false
        const at = Date.parse(s.observed_at)
        if (after !== null && !Number.isNaN(at) && at < after) return false
        if (before !== null && !Number.isNaN(at) && at > before) return false
        return true
      })

      // Parse each timestamp once rather than on every comparison, and break
      // ties on claim_id so the order is total: two claims written in the same
      // millisecond would otherwise land in an order that varies between calls,
      // which a cursor cannot page through reliably.
      const byObserved = i.order.startsWith('observed')
      const descending = i.order.endsWith('desc')
      matched = matched
        .map((s) => ({
          at: Date.parse(byObserved ? s.observed_at : s.recorded_at) || 0,
          claim: s,
        }))
        .sort((a, b) => {
          const delta = descending ? b.at - a.at : a.at - b.at
          if (delta !== 0) return delta
          return descending
            ? b.claim.claim_id.localeCompare(a.claim.claim_id)
            : a.claim.claim_id.localeCompare(b.claim.claim_id)
        })
        .map((x) => x.claim)

      const start = cursor?.o ?? 0
      const end = start + i.limit
      const page = matched.slice(start, end)
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

// ── recall.history ──────────────────────────────────────────────────────────

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

      if (events.length === 0) {
        return Err(
          toolError('CLAIM_NOT_FOUND', `no claim ${i.claim_id} in project ${ctx.project}`, {
            detail: { claim_id: i.claim_id, project: ctx.project },
          }),
        )
      }

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
