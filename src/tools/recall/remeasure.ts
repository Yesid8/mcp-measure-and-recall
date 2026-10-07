import { containsRedaction } from '../../kernel/redact.js'
import type { EvidenceRecord } from '../../store/store.js'

/**
 * remeasure_with: the tool and arguments to take a claim's evidence again.
 *
 * Rule F1 made mechanical: the registry hands back the way to re-measure
 * instead of pretending it knows the current state.
 */

export interface RemeasureWith {
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly omitted: string[]
}

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
export function remeasureWith(
  evidence: readonly EvidenceRecord[],
  project: string,
): RemeasureWith | null {
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
