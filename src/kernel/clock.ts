/**
 * The clock is injected so ages can be tested without real waits.
 *
 * Why age_seconds comes from the monotonic clock: subtracting two wall-clock
 * Dates gives absurd results when the system clock jumps (NTP, suspend, a
 * container starting with the wrong time). A negative age_seconds in a response
 * destroys the one rule that makes this server valuable.
 *
 * For data read from disk — where the monotonic instant of the write no longer
 * exists — the age comes from the difference of wall clocks, and is marked
 * age_basis: 'wall' so the difference is visible rather than assumed.
 */

/** Which clock an age was measured on; 'wall' is the weaker of the two. */
export type AgeBasis = 'monotonic' | 'wall'

/** Time as the server sees it, injected so tests can move it. */
export interface Clock {
  /** Wall clock, for observed_at. */
  now(): Date
  /** Monotonic milliseconds, for durations and ages. Immune to NTP jumps. */
  monotonic(): number
  /** Cancellable sleep. Never use a bare setTimeout. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

/** The real clock, used everywhere outside tests. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }

  monotonic(): number {
    // performance.now() is monotonic per Node process and unaffected by NTP.
    return performance.now()
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError(signal))
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/**
 * ISO 8601 with a real offset, not a Z-normalized string.
 *
 * The contract says "ISO 8601 with offset". toISOString() always yields UTC,
 * which loses the observer's offset; a reader cannot tell 09:00 in Madrid from
 * 09:00 in UTC. We render local time with its explicit offset.
 */
export function toIsoWithOffset(d: Date, offsetMinutes = -d.getTimezoneOffset()): string {
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const oh = String(Math.floor(abs / 60)).padStart(2, '0')
  const om = String(abs % 60).padStart(2, '0')
  const shifted = new Date(d.getTime() + offsetMinutes * 60_000)
  const base = shifted.toISOString().slice(0, 23)
  return `${base}${sign}${oh}:${om}`
}

/**
 * Age in seconds, clamped at zero.
 *
 * Clamping is not cosmetic: a negative age would be a judgement-free field
 * telling an outright lie. If the underlying clock went backwards we report 0
 * and let the caller see freshness, never a value from the future.
 */
export function ageSeconds(elapsedMs: number): number {
  return Math.max(0, elapsedMs) / 1000
}
