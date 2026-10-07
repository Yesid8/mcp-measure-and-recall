import { ErrorCodes, Err, Ok, type Result, toolError } from './result.js'

/**
 * A project is a free string, normalized. It is created on first use.
 *
 * This normalization is all the knowledge of projects this server has. It does
 * not know what any project is, and does not care.
 *
 * Every tool that takes a project returns the normalized form, so the caller
 * sees which identity was written under. A typo fragments a registry; returning
 * the normalized form makes it visible on the first call.
 */

const MAX_LEN = 64

/**
 * Lower-cases, folds accents, turns every run outside `[a-z0-9._-]` into one
 * `-`, collapses dot runs and trims `-` and `.` from both ends. The result is
 * 1 to 64 characters, or an INVALID_PROJECT error.
 */
export function normalizeProject(raw: string): Result<string> {
  // Accents are folded before the ASCII filter, so "Almacén" becomes "almacen"
  // rather than "almac-n": decomposition splits é into e + a combining mark,
  // and only the mark is dropped.
  // Dot runs collapse and edge dots go, so no normalized name can contain `..`
  // or be `.`: the path layer rejects those, and a name that normalizes cleanly
  // must never be refused one step later for a reason the caller cannot see.
  const collapsed = raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')

  if (collapsed.length === 0) {
    return Err(
      toolError(ErrorCodes.INVALID_PROJECT, 'project is empty after normalization', {
        detail: { received: raw },
      }),
    )
  }
  if (collapsed.length > MAX_LEN) {
    return Err(
      toolError(
        ErrorCodes.INVALID_PROJECT,
        `project is ${collapsed.length} characters after normalization, maximum is ${MAX_LEN}`,
        { detail: { received: raw, normalized: collapsed } },
      ),
    )
  }
  return Ok(collapsed)
}

/**
 * Tags follow the same rules as projects, so the registry stays queryable. The
 * error is re-coded: INVALID_PROJECT would send the caller to fix the wrong
 * argument.
 */
export function normalizeTag(raw: string): Result<string> {
  const normalized = normalizeProject(raw)
  if (normalized.ok) return normalized
  return Err(
    toolError(
      ErrorCodes.INVALID_INPUT,
      `tag ${JSON.stringify(raw)}: ${normalized.error.message.replace(/^project /, '')}`,
      { detail: { tag: raw } },
    ),
  )
}
