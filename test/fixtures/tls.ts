import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A throwaway self-signed certificate for 127.0.0.1, generated per test run.
 *
 * Generated rather than committed: a private key in a public repository trips
 * secret scanners even when it is a test key. Tests that need it skip when no
 * openssl binary is available.
 */

const CANDIDATES = [
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
]

function findOpenssl(): string | null {
  for (const bin of CANDIDATES) {
    if (bin.includes('\\') && !existsSync(bin)) continue
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' })
      return bin
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

const OPENSSL = findOpenssl()

export const hasOpenssl = OPENSSL !== null

export function selfSignedCert(): { key: string; cert: string } {
  if (OPENSSL === null) throw new Error('openssl is not available')
  const dir = mkdtempSync(join(tmpdir(), 'plinth-tls-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync(
    OPENSSL,
    // prettier-ignore
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', key, '-out', cert,
    ],
    { stdio: 'ignore' },
  )
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}
