import { open, readFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../kernel/result.js'

/**
 * Instance lock: one process per data directory.
 *
 * Why this is not optional. Each MCP client launches its own server process, so
 * two servers over the same PLINTH_DATA_DIR is not an edge case — it is what
 * happens as soon as two applications are connected. Write serialization lives
 * inside the process (one queue per stream), so two processes can interleave
 * writes and split a line of the registry. That would corrupt exactly the
 * evidence this server exists to produce.
 *
 * Taken with O_CREAT|O_EXCL, holding the PID. A lock whose PID is dead is
 * stale and gets taken over; a lock whose PID is alive fails the startup with a
 * message that names the process, because silently sharing the directory is the
 * failure mode we are preventing.
 */

/** Raised when another live process holds the data directory. */
export const DATA_DIR_IN_USE = ErrorCodes.DATA_DIR_IN_USE

/** Proof of holding the lock. Release it on shutdown; a crash leaves it stale. */
export interface LockHandle {
  readonly path: string
  release(): Promise<void>
}

interface LockFile {
  readonly pid: number
  readonly at: string
  readonly host: string
}

/** Whether a PID is alive. Signal 0 checks existence without touching it. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means it exists but belongs to another user: alive for our purposes.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes `<dataDir>/LOCK`, taking over a stale one; fails if its holder is alive. */
export async function acquireInstanceLock(dataDir: string): Promise<Result<LockHandle>> {
  const path = join(dataDir, 'LOCK')

  try {
    await mkdir(dataDir, { recursive: true })
  } catch (e) {
    return Err(
      toolError(ErrorCodes.STORAGE_ERROR, 'could not create the data directory', { cause: e }),
    )
  }

  const body: LockFile = {
    pid: process.pid,
    at: new Date().toISOString(),
    host: process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? 'unknown',
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_CREAT|O_EXCL: the create and the exclusivity check are one atomic step.
      const fh = await open(path, 'wx')
      await fh.writeFile(JSON.stringify(body))
      await fh.sync()
      await fh.close()
      return Ok({
        path,
        release: async () => {
          // Only remove a lock that is still ours: a stale takeover may have
          // replaced it, and deleting someone else's lock is worse than leaking.
          try {
            const raw = await readFile(path, 'utf8')
            const held = JSON.parse(raw) as LockFile
            if (held.pid === process.pid) await unlink(path)
          } catch {
            /* already gone, or unreadable: nothing useful left to do */
          }
        },
      })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        return Err(
          toolError(ErrorCodes.STORAGE_ERROR, 'could not create the instance lock', { cause: e }),
        )
      }

      // Taken. Decide whether the holder is alive or the lock is stale.
      let held: LockFile | null = null
      try {
        held = JSON.parse(await readFile(path, 'utf8')) as LockFile
      } catch {
        held = null // unreadable or truncated: treat as stale
      }

      if (held !== null && pidAlive(held.pid)) {
        return Err(
          toolError(
            DATA_DIR_IN_USE,
            `the data directory is in use by process ${held.pid} (locked at ${held.at}). Point this server at its own PLINTH_DATA_DIR, or stop that process.`,
            { detail: { lock_path: path, held_by_pid: held.pid, held_since: held.at } },
          ),
        )
      }

      // Stale: remove and retry once. A race here is harmless — the loser of
      // the retry sees EEXIST again and reports the live holder.
      try {
        await unlink(path)
      } catch {
        /* someone else cleaned it first */
      }
    }
  }

  // Both attempts met a lock: another process won the stale takeover.
  return Err(
    toolError(DATA_DIR_IN_USE, 'another process took the data directory during a stale takeover', {
      detail: { lock_path: path },
    }),
  )
}
