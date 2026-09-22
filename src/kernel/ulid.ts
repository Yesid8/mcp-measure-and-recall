import { randomFillSync } from 'node:crypto'

/**
 * ULID: 26 characters, Crockford base32, lexicographically sortable by time,
 * monotonic within the same millisecond — per process, since the counter lives
 * in module state and the instance lock keeps one process per data directory.
 *
 * Why ULID and not UUIDv7: both sort by time; a ULID reads, writes and pastes
 * without hyphens and is half the length in base32. For an identifier a language
 * model must transcribe from one response into the next call, that matters.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32, no I L O U
const TIME_LEN = 10
const RANDOM_LEN = 16

let lastTime = -1
/** One base32 digit (0-31) per slot, so the increment carries at 32, as the encoding does. */
let lastRandom = new Uint8Array(RANDOM_LEN)

function encodeTime(now: number): string {
  let out = ''
  let t = now
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32
    out = ENCODING[mod]! + out
    t = (t - mod) / 32
  }
  return out
}

function encodeRandom(digits: Uint8Array): string {
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[digits[i]!]!
  return out
}

/**
 * Increments the random part as a base32 number, so ids stay ordered within a
 * millisecond. The carry must happen at 32, not 256: carrying at the byte
 * boundary turns a 'Z' digit into '0' without touching the next one, and the
 * next id then sorts before the previous.
 */
function bumpRandom(digits: Uint8Array): void {
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    if (digits[i]! < 31) {
      digits[i]! += 1
      return
    }
    digits[i] = 0
  }
}

/**
 * A new ULID. It reads the real clock rather than the injected one on purpose:
 * ids only need to be unique and ordered, and a test clock that jumps would
 * make neither easier.
 */
export function ulid(now: number = Date.now()): string {
  // A wall clock that steps backwards (NTP, suspend) must not produce an id that
  // sorts before one already issued: stay on the last millisecond and bump.
  if (now <= lastTime) {
    bumpRandom(lastRandom)
  } else {
    lastTime = now
    randomFillSync(lastRandom)
    for (let i = 0; i < RANDOM_LEN; i++) lastRandom[i] = lastRandom[i]! & 31
  }
  return encodeTime(lastTime) + encodeRandom(lastRandom)
}

/**
 * One prefix per kind of identifier, so an id pasted into the wrong argument is
 * recognisable at a glance — by a person or by the model reading it back.
 */
export const IdPrefix = {
  observation: 'o_',
  event: 'e_',
  request: 'r_',
  claim: 'c_',
} as const

/** `<prefix><ULID>`, e.g. `o_01K5Z9K2QX7T4BVWRM3P8QJHYD`. */
export function newId(prefix: string, now?: number): string {
  return prefix + ulid(now)
}
