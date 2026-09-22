import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:https'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { hasOpenssl, selfSignedCert } from '../fixtures/tls.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'

/**
 * Certificate verification is on for both https:// and wss://. A measurement
 * that silently accepted any certificate would report a peer it never proved
 * it reached.
 */

describe.skipIf(!hasOpenssl)('TLS', () => {
  let server: Server
  let port: number
  let client: TestClient

  beforeAll(async () => {
    const { key, cert } = selfSignedCert()
    server = createServer({ key, cert }, (_req, res) => res.end('secret page'))
    // The WebSocket upgrade never gets far enough to matter: the handshake fails first.
    server.on('upgrade', (_req, socket) => socket.destroy())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-tls-')) })
  })

  afterAll(async () => {
    await client.closeAsync()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it.each([
    ['facts.measure.http', { url: () => `https://127.0.0.1:${port}/` }],
    ['facts.measure.ws', { url: () => `wss://127.0.0.1:${port}/`, listen_seconds: 0.2 }],
  ])('%s refuses a self-signed certificate', async (tool, extra) => {
    const { url, ...rest } = extra as { url: () => string } & Record<string, unknown>
    const out = readToolResult(
      await client.request('tools/call', {
        name: tool,
        arguments: { project: 'p', url: url(), ...rest },
      }),
    )
    expect(out.isError).toBe(true)
    expect((out.envelope['error'] as { code: string }).code).toBe('TLS_ERROR')
  })
})
