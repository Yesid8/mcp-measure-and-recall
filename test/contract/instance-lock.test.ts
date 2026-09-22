import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock, type LockHandle } from '../../src/store/instance-lock.js'

/**
 * Stage B0: the instance lock.
 *
 * The scenario this protects is not exotic. Every MCP client launches its own
 * server process, so two servers over one data directory happens as soon as two
 * applications are connected — which is exactly the shape of stage A5.
 */

let dataDir: string
const held: LockHandle[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'plinth-lock-'))
})
afterEach(async () => {
  for (const h of held.splice(0)) await h.release()
})

const lockPath = () => join(dataDir, 'LOCK')

describe('one process per data directory', () => {
  it('takes the lock and records who holds it', async () => {
    const first = await acquireInstanceLock(dataDir)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    held.push(first.value)

    const body = JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number; at: string }
    expect(body.pid).toBe(process.pid)
    expect(Number.isNaN(Date.parse(body.at))).toBe(false)
  })

  it('refuses a second holder and names the live process', async () => {
    const first = await acquireInstanceLock(dataDir)
    expect(first.ok).toBe(true)
    if (first.ok) held.push(first.value)

    const second = await acquireInstanceLock(dataDir)
    expect(second.ok).toBe(false)
    if (second.ok) return

    expect(second.error.code).toBe('DATA_DIR_IN_USE')
    // The message has to be actionable: its reader is staring at a client that
    // will not connect.
    expect(second.error.message).toContain(String(process.pid))
    expect(second.error.message).toContain('PLINTH_DATA_DIR')
    expect((second.error.detail as { held_by_pid: number }).held_by_pid).toBe(process.pid)
  })

  it('lets a different directory proceed untouched', async () => {
    const first = await acquireInstanceLock(dataDir)
    if (first.ok) held.push(first.value)

    const other = mkdtempSync(join(tmpdir(), 'plinth-lock-other-'))
    const second = await acquireInstanceLock(other)
    expect(second.ok).toBe(true)
    if (second.ok) held.push(second.value)
  })
})

describe('a stale lock does not wedge the server forever', () => {
  it('takes over a lock whose PID is dead', async () => {
    // A PID that cannot be running: the process that wrote it died without
    // releasing, which is what a crash or a kill -9 leaves behind.
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 0x7ffffffe, at: new Date().toISOString(), host: 'gone' }),
    )

    const taken = await acquireInstanceLock(dataDir)
    expect(taken.ok).toBe(true)
    if (!taken.ok) return
    held.push(taken.value)

    const body = JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number }
    expect(body.pid).toBe(process.pid)
  })

  it('takes over an unreadable lock rather than refusing to start', async () => {
    writeFileSync(lockPath(), 'this is not json')
    const taken = await acquireInstanceLock(dataDir)
    expect(taken.ok).toBe(true)
    if (taken.ok) held.push(taken.value)
  })
})

describe('failures other than contention', () => {
  it('reports a data directory it cannot create as STORAGE_ERROR', async () => {
    const file = join(dataDir, 'a-file')
    writeFileSync(file, 'x')
    const r = await acquireInstanceLock(file)
    expect(!r.ok && r.error.code).toBe('STORAGE_ERROR')
  })

  it('treats a lock naming an impossible pid as stale', async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: -1, at: 'x', host: 'h' }))
    const taken = await acquireInstanceLock(dataDir)
    expect(taken.ok).toBe(true)
    if (taken.ok) held.push(taken.value)
  })
})

describe('release', () => {
  it('is harmless when the lock file is already gone', async () => {
    const first = await acquireInstanceLock(dataDir)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const { unlinkSync } = await import('node:fs')
    unlinkSync(lockPath())
    await expect(first.value.release()).resolves.toBeUndefined()
  })

  it('removes the lock so the next process can start', async () => {
    const first = await acquireInstanceLock(dataDir)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    await first.value.release()
    expect(existsSync(lockPath())).toBe(false)

    const second = await acquireInstanceLock(dataDir)
    expect(second.ok).toBe(true)
    if (second.ok) held.push(second.value)
  })

  it('does not remove a lock that a stale takeover reassigned', async () => {
    const first = await acquireInstanceLock(dataDir)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Someone else took over after deciding ours was stale.
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 999_999, at: new Date().toISOString(), host: 'other' }),
    )

    await first.value.release()
    // Their lock survives: deleting another process's lock is worse than leaking ours.
    const body = JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number }
    expect(body.pid).toBe(999_999)
  })
})
