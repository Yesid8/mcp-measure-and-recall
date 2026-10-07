import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../kernel/result.js'

/**
 * On-disk layout and path safety.
 *
 * The process never writes outside the data root. Every path is built with
 * join() from the root and then checked with resolve() plus realpath(), so a
 * symlink cannot escape either.
 */

/** PLINTH_DATA_DIR when set and non-empty, resolved to an absolute path; else ~/.plinth. */
export function dataRoot(): string {
  const configured = process.env['PLINTH_DATA_DIR']
  return configured !== undefined && configured.length > 0
    ? resolve(configured)
    : join(homedir(), '.plinth')
}

/** The directories one project writes to. */
export interface ProjectPaths {
  readonly logs: string
}

/**
 * Resolves the directories for a project, creating them on first use.
 *
 * `project` must already be normalized: normalizeProject() guarantees it holds
 * no separators, which is the first line of defence. The realpath check is the
 * second, and it is the one that survives a symlink planted in the data dir.
 */
export async function projectPaths(root: string, project: string): Promise<Result<ProjectPaths>> {
  if (project.includes('/') || project.includes('\\') || project.includes('..')) {
    return Err(
      toolError(ErrorCodes.PATH_NOT_ALLOWED, 'project name cannot traverse directories', {
        detail: { project },
      }),
    )
  }

  const projectRoot = join(root, 'projects', project)
  // Only the directories something writes to. The blob store of
  // 04-almacenamiento §4 is postponed; it creates its own directory when built.
  const logs = join(projectRoot, 'logs')

  try {
    await mkdir(logs, { recursive: true })
  } catch (e) {
    return Err(
      toolError(ErrorCodes.STORAGE_ERROR, 'could not create the project directories', { cause: e }),
    )
  }

  // Resolve symlinks and confirm we are still inside the root. The deepest
  // directory is the one resolved: a link planted at any level above it —
  // projects/, the project, or logs/ itself — shows up in its real path.
  let realRoot: string
  let realLogs: string
  try {
    realRoot = await realpath(root)
    realLogs = await realpath(logs)
  } catch (e) {
    return Err(
      toolError(ErrorCodes.STORAGE_ERROR, 'could not resolve the data directory', { cause: e }),
    )
  }

  if (!realLogs.startsWith(realRoot + sep)) {
    return Err(
      toolError(
        ErrorCodes.PATH_NOT_ALLOWED,
        'the project directory resolves outside the data root',
        {
          detail: { project },
        },
      ),
    )
  }

  return Ok({ logs })
}
