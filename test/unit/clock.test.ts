import { describe, expect, it } from 'vitest'
import { SystemClock, ageSeconds, toIsoWithOffset } from '../../src/kernel/clock.js'

describe('toIsoWithOffset keeps the observer offset', () => {
  const instant = new Date('2026-01-01T02:00:00.000Z')

  it.each([
    [0, '2026-01-01T02:00:00.000+00:00'],
    [120, '2026-01-01T04:00:00.000+02:00'],
    // Crosses back over midnight and the year boundary.
    [-300, '2025-12-31T21:00:00.000-05:00'],
    // Half- and quarter-hour offsets exist (India, Nepal).
    [330, '2026-01-01T07:30:00.000+05:30'],
    [345, '2026-01-01T07:45:00.000+05:45'],
  ])('offset %i minutes -> %s', (offset, expected) => {
    expect(toIsoWithOffset(instant, offset)).toBe(expected)
  })

  it('names the same instant as the UTC form', () => {
    const iso = toIsoWithOffset(instant, -300)
    expect(Date.parse(iso)).toBe(instant.getTime())
  })

  it('uses the local offset by default', () => {
    expect(Date.parse(toIsoWithOffset(instant))).toBe(instant.getTime())
  })
})

describe('ageSeconds', () => {
  it('converts milliseconds to seconds', () => {
    expect(ageSeconds(1500)).toBe(1.5)
  })

  it('clamps a negative elapsed time to zero instead of reporting the future', () => {
    expect(ageSeconds(-10_000)).toBe(0)
  })
})

describe('SystemClock', () => {
  const clock = new SystemClock()

  it('has a monotonic clock that never goes backwards', () => {
    let prev = clock.monotonic()
    for (let i = 0; i < 1000; i++) {
      const next = clock.monotonic()
      expect(next).toBeGreaterThanOrEqual(prev)
      prev = next
    }
  })

  it('sleeps for the requested time', async () => {
    const started = clock.monotonic()
    await clock.sleep(30, new AbortController().signal)
    expect(clock.monotonic() - started).toBeGreaterThanOrEqual(25)
  })

  it('rejects at once when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort(new Error('stop'))
    await expect(clock.sleep(10_000, c.signal)).rejects.toThrow('stop')
  })

  it('rejects when aborted mid-sleep, with the abort reason', async () => {
    const c = new AbortController()
    const pending = clock.sleep(10_000, c.signal)
    setTimeout(() => c.abort(new Error('cancelled')), 10)
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('rejects with an AbortError when the reason is not an Error', async () => {
    const c = new AbortController()
    c.abort('plain string reason')
    await expect(clock.sleep(10_000, c.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
