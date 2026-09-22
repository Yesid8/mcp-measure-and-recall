import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The built binary, as a client launches it.
 *
 * Every other test imports src/ directly, so none of them would notice a
 * broken build: a missing file in dist/, a wrong shebang, an import that only
 * resolves under the TypeScript loader, a package.json the binary cannot find.
 * This one runs dist/main.js in its own process over real pipes. `npm test`
 * builds first; run `npm run build` before invoking vitest by hand.
 */

const MAIN = resolve('dist/main.js')
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { tools: {} },
}

type Response = { id: number; result?: Record<string, unknown>; error?: unknown }

describe('the built binary', () => {
  it('answers server/discover and tools/list over stdio, then exits cleanly', async () => {
    expect(existsSync(MAIN), 'dist/main.js is missing: run `npm run build` first').toBe(true)

    const child = spawn(process.execPath, [MAIN], {
      env: { ...process.env, PLINTH_DATA_DIR: mkdtempSync(join(tmpdir(), 'plinth-bin-')) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))

    let stderr = ''
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    const lines: string[] = []
    let buf = ''
    const responses = new Promise<Map<number, Response>>((resolve, reject) => {
      const byId = new Map<number, Response>()
      child.stdout.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        let i: number
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          lines.push(line)
          const msg = JSON.parse(line) as Response
          byId.set(msg.id, msg)
          if (byId.size === 2) resolve(byId)
        }
      })
      child.once('exit', () => reject(new Error(`exited before answering:\n${stderr}`)))
    })

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) + '\n')
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META } }) +
        '\n',
    )

    const byId = await responses
    const discover = byId.get(1)!.result!
    const list = byId.get(2)!.result!
    expect(discover['resultType']).toBe('complete')
    expect(list['resultType']).toBe('complete')

    // Packaging: the version comes from package.json, found relative to dist/.
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect((discover['serverInfo'] as { version: string }).version).toBe(version)
    expect((list['tools'] as { name: string }[]).map((t) => t.name)).toEqual([
      'facts.measure.http',
      'facts.measure.ws',
      'facts.recall.assert',
      'facts.recall.history',
      'facts.recall.query',
      'facts.recall.retract',
    ])

    // Closing stdin is how a client says goodbye; the server drains and exits 0.
    child.stdin.end()
    expect(await exited).toBe(0)
    // stdout carried only the two responses: nothing else may share the protocol stream.
    expect(lines).toHaveLength(2)
    expect(stderr).not.toContain('facts-mcp:')
  })
})
