/**
 * Secret redaction.
 *
 * A server that stores requests with headers inside is an accidental credential
 * store. Redaction happens at a single point — building `target` and any data
 * marked for it — and every tool inherits it.
 *
 * Two rules that are easy to get backwards:
 *   1. Values are sent INTACT to the destination; they are redacted only on the
 *      way out to the client and to disk.
 *   2. Redaction is applied BEFORE persisting, never after. There is no window
 *      in which the secret sits in the file.
 */

/**
 * A key is secret when its LAST segment names a credential.
 *
 * Matching the final segment rather than a fixed list catches the variants a
 * list always misses — `api_key`, `x-csrf-token`, `db_password` — while leaving
 * alone keys that merely mention one, like `max_tokens` or `token_count`, whose
 * values are data the caller came to observe.
 */
const SECRET_KEY =
  /(?:^|[-_.])(?:authorization|cookie|set-cookie|token|secret|password|passwd|api-?key|apikey|private-?key|session|sid|credentials?)$/

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\bsk-[A-Za-z0-9]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/**
 * `user:password@` in a URL. Only the userinfo is replaced: keeping the scheme
 * and host leaves the URL readable, and parseable once the userinfo is removed.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@[\]]+:[^/\s@[\]]+)@/gi

/**
 * One `name=value` pair of a query string, with the separator before it. A
 * value may already be a marker, whose space would otherwise end it early.
 */
const QUERY_PAIR = /([?&])([^=&#\s]+)=(\[redacted[^\]]*\]|[^&#\s]*)/g

/**
 * Any marker this module writes. Recognizing its own output is what makes
 * redaction idempotent, and lets remeasure_with leave out what was redacted.
 */
const MARKER = /\[redacted(?::\d+ bytes|: depth limit)?\]/

/**
 * Keeps the length — useful for diagnosing — without keeping the secret.
 */
export function redactedMarker(value: string): string {
  return `[redacted:${Buffer.byteLength(value, 'utf8')} bytes]`
}

/** Whether a string holds a redaction marker, anywhere in it. */
export function containsRedaction(value: string): boolean {
  return MARKER.test(value)
}

/** Marks a secret value, leaving one that is already a marker as it is. */
function mark(value: string): string {
  return MARKER.test(value) ? value : redactedMarker(value)
}

function queryKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '))
  } catch {
    return raw
  }
}

/** Whether a header, JSON or query key names a credential. See SECRET_KEY. */
export function isSecretKey(key: string): boolean {
  // `_` and `-` are interchangeable across headers, JSON and query strings.
  return SECRET_KEY.test(key.toLowerCase().replaceAll('_', '-'))
}

/**
 * Applies value-level patterns to a free string: known token shapes, URL
 * userinfo, and query parameters whose name is a secret key (`?token=…`).
 */
export function redactText(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => redactedMarker(m))
  }
  out = out.replace(URL_USERINFO, (_m, scheme: string, userinfo: string) => {
    return `${scheme}${mark(userinfo)}@`
  })
  return out.replace(QUERY_PAIR, (m, sep: string, name: string, value: string) =>
    value.length > 0 && isSecretKey(queryKey(name)) ? `${sep}${name}=${mark(value)}` : m,
  )
}

/** Bounds the walk over a hostile or pathological structure. */
const MAX_DEPTH = 12

/** What replaces a subtree we refused to walk. */
const TRUNCATED = '[redacted: depth limit]'

/** What replaces a non-string value held under a secret key. */
const REPLACED = '[redacted]'

/**
 * A deep copy of `value` that is safe to return and to store: whole values under
 * secret keys are replaced, and secret patterns inside any other string too.
 * Never mutates its input.
 */
export function redact(value: unknown, depth = 0): unknown {
  // Fail closed. Returning the value intact here would make the depth limit a
  // silent hole in the one guarantee this module exists to provide, and what it
  // let through would go straight to disk.
  if (depth > MAX_DEPTH) return TRUNCATED
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      // A secret key redacts its whole value, string or not. HTTP repeats a
      // header name as an array, so `x-api-key: [token]` would otherwise leave
      // an opaque token — one that matches no pattern — in the clear.
      out[k] = isSecretKey(k) ? redactSecretValue(v) : redact(v, depth + 1)
    }
    return out
  }
  return value
}

/** Redacts a value under a secret key, preserving array shape but no content. */
function redactSecretValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return mark(value)
  if (Array.isArray(value)) return value.map(redactSecretValue)
  // A number or object under a secret key is anomalous; replace it wholesale
  // rather than walk it, so no part of a secret leaks through its structure.
  return REPLACED
}

/**
 * Strips credential-bearing headers entirely rather than redacting them.
 *
 * Used for `remeasure_with`: those arguments are meant to be replayed, and a
 * redacted marker replayed as a header value would be a broken request that
 * looks like a valid one. Whoever re-measures supplies their own credentials.
 */
export function stripSecretKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!isSecretKey(k)) out[k] = v
  }
  return out
}
