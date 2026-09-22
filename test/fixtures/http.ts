import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'

/**
 * A real local HTTP server for measurement tests.
 *
 * Counts requests per path so "exactly one request arrived — zero implicit
 * retries" is checkable rather than assumed.
 */
export interface HttpFixture {
  readonly port: number
  readonly origin: string
  readonly hits: ReadonlyMap<string, number>
  hitCount(path: string): number
  readonly received: readonly {
    path: string
    headers: Record<string, string | string[] | undefined>
  }[]
  close(): Promise<void>
}

export async function httpFixture(): Promise<HttpFixture> {
  const hits = new Map<string, number>()
  const received: { path: string; headers: Record<string, string | string[] | undefined> }[] = []

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    hits.set(path, (hits.get(path) ?? 0) + 1)
    received.push({ path, headers: req.headers })

    switch (path) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ orders: [] }))
        return
      case '/boom':
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal' }))
        return
      case '/text':
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('plain words')
        return
      case '/lying-json':
        // Declares JSON, is not JSON: must come back as text with a warning.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('<html>not json</html>')
        return
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('x'.repeat(200_000))
        return
      case '/gzip-bomb': {
        const bomb = gzipSync(Buffer.alloc(5_000_000, 0x41))
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
        res.end(bomb)
        return
      }
      case '/redirect-local':
        res.writeHead(302, { location: '/ok' })
        res.end()
        return
      case '/deflate':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' })
        res.end(deflateSync(Buffer.from('deflated body')))
        return
      case '/br':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' })
        res.end(brotliCompressSync(Buffer.from('brotli body')))
        return
      case '/binary':
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
        return
      case '/empty':
        res.writeHead(204)
        res.end()
        return
      case '/redirect-loop':
        res.writeHead(302, { location: '/redirect-loop' })
        res.end()
        return
      case '/redirect-bad-location':
        // A Location that cannot parse even against a base URL.
        res.writeHead(302, { location: 'http://[not-an-ip' })
        res.end()
        return
      case '/redirect-303':
        // A real client turns the follow-up into a bodyless GET.
        res.writeHead(303, { location: '/echo-method' })
        res.end()
        return
      case '/echo-method':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            method: req.method,
            had_body: (req.headers['content-length'] ?? '0') !== '0',
            content_type: req.headers['content-type'] ?? null,
          }),
        )
        return
      case '/redirect-other-origin': {
        // Another loopback port: allowed by the policy, but a different origin,
        // so credentials must not travel there.
        const to = url.searchParams.get('to') ?? ''
        res.writeHead(302, { location: `http://127.0.0.1:${to}/echo-auth` })
        res.end()
        return
      }
      case '/redirect-public':
        res.writeHead(302, { location: 'http://example.com/' })
        res.end()
        return
      case '/trickle': {
        // Headers at once, then one byte every 100 ms for 3 s: never idle long
        // enough to trip a socket-inactivity timeout, yet far over a total budget.
        res.writeHead(200, { 'content-type': 'text/plain' })
        let sent = 0
        const t = setInterval(() => {
          if (res.destroyed || sent >= 30) {
            clearInterval(t)
            if (!res.destroyed) res.end()
            return
          }
          res.write('x')
          sent++
        }, 100)
        res.once('close', () => clearInterval(t))
        return
      }
      case '/slow':
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('late')
        }, 5_000)
        return
      case '/echo-auth':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ authorization: req.headers['authorization'] ?? null }))
        return
      case '/set-cookie':
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'session=super-secret-value; Path=/',
        })
        res.end('{}')
        return
      default:
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    hits,
    hitCount: (p) => hits.get(p) ?? 0,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A fake resolver, so rebinding attacks are testable without real DNS. */
export function fakeResolver(map: Record<string, { address: string; family: number }[]>) {
  return async (hostname: string) => {
    const entry = map[hostname]
    if (entry === undefined) throw new Error(`ENOTFOUND ${hostname}`)
    return entry
  }
}
