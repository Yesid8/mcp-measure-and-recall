import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dataRoot, projectPaths } from '../../src/store/paths.js'

const saved = process.env['PLINTH_DATA_DIR']
afterEach(() => {
  if (saved === undefined) delete process.env['PLINTH_DATA_DIR']
  else process.env['PLINTH_DATA_DIR'] = saved
})

describe('dataRoot', () => {
  it('uses PLINTH_DATA_DIR, resolved to an absolute path', () => {
    process.env['PLINTH_DATA_DIR'] = 'relative-dir'
    expect(dataRoot()).toBe(resolve('relative-dir'))
  })

  it('falls back to ~/.plinth when the variable is unset or empty', () => {
    delete process.env['PLINTH_DATA_DIR']
    expect(dataRoot()).toBe(join(homedir(), '.plinth'))
    process.env['PLINTH_DATA_DIR'] = ''
    expect(dataRoot()).toBe(join(homedir(), '.plinth'))
  })
})

describe('projectPaths never leaves the data root', () => {
  it('creates the logs directory for a project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plinth-paths-'))
    const r = await projectPaths(root, 'demo')
    expect(r.ok && r.value.logs).toBe(join(root, 'projects', 'demo', 'logs'))
  })

  it.each(['../escape', 'a/b', 'a\\b', '..'])('refuses %s', async (name) => {
    const root = mkdtempSync(join(tmpdir(), 'plinth-paths-'))
    const r = await projectPaths(root, name)
    expect(!r.ok && r.error.code).toBe('PATH_NOT_ALLOWED')
  })

  it('refuses a project directory that a link points outside the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plinth-paths-'))
    const outside = mkdtempSync(join(tmpdir(), 'plinth-outside-'))
    mkdirSync(join(root, 'projects'), { recursive: true })
    // A junction needs no privileges on Windows; elsewhere the type is ignored.
    symlinkSync(outside, join(root, 'projects', 'planted'), 'junction')

    const r = await projectPaths(root, 'planted')
    expect(!r.ok && r.error.code).toBe('PATH_NOT_ALLOWED')
  })

  it('refuses a logs directory that a link points outside the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plinth-paths-'))
    const outside = mkdtempSync(join(tmpdir(), 'plinth-outside-'))
    mkdirSync(join(root, 'projects', 'demo'), { recursive: true })
    symlinkSync(outside, join(root, 'projects', 'demo', 'logs'), 'junction')

    const r = await projectPaths(root, 'demo')
    expect(!r.ok && r.error.code).toBe('PATH_NOT_ALLOWED')
  })

  it('reports a data root it cannot create in as STORAGE_ERROR', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'plinth-paths-'))
    const file = join(parent, 'not-a-directory')
    writeFileSync(file, 'x')
    const r = await projectPaths(file, 'demo')
    expect(!r.ok && r.error.code).toBe('STORAGE_ERROR')
  })
})
