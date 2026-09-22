import type { Clock } from '../../src/kernel/clock.js'

/**
 * A controllable clock.
 *
 * It keeps wall time and monotonic time SEPARATE, on purpose: that is the only
 * way to test that ages come from the monotonic clock. jumpWallClock moves the
 * wall clock without touching the monotonic one, which is exactly what NTP, a
 * suspend, or a container with the wrong time does to a real process.
 */
export class FakeClock implements Clock {
  #wall: number
  #mono: number

  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z'), monoStart = 1000) {
    this.#wall = start.getTime()
    this.#mono = monoStart
  }

  now(): Date {
    return new Date(this.#wall)
  }

  monotonic(): number {
    return this.#mono
  }

  /** Moves both clocks forward, as real elapsed time does. */
  advance(ms: number): void {
    this.#wall += ms
    this.#mono += ms
  }

  /** Moves ONLY the wall clock. A monotonic clock cannot go backwards. */
  jumpWallClock(ms: number): void {
    this.#wall += ms
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Aborted')
    // Real I/O in these tests still needs real time to pass; the fake clock only
    // governs what the code reads, not when the event loop runs.
    await new Promise((r) => setTimeout(r, Math.min(ms, 5)))
    this.advance(ms)
  }
}
