import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { classifyIp, type IpClass } from './ip.js'
import { ErrorCodes, Err, Ok, toolError, type Result } from '../kernel/result.js'

/**
 * What a measurement may reach, by the class of every resolved address:
 * - `deny-all`: nothing.
 * - `loopback`: this machine only. The default.
 * - `private`: loopback plus RFC 1918 and unique-local ranges.
 * - `allowlist`: exactly the `host:port` pairs in `allowHosts`, public or not.
 * Link-local and unspecified addresses are refused under every profile.
 */
export type NetProfile = 'deny-all' | 'loopback' | 'private' | 'allowlist'

/** Fixed when the server starts; no tool can widen it. */
export interface NetPolicy {
  readonly profile: NetProfile
  /** Exact host:port. No domain wildcards, ever. */
  readonly allowHosts?: readonly string[]
  /** Hops followed when a caller asks to follow redirects. */
  readonly maxRedirects?: number
  /** Injectable for tests: resolves a hostname to addresses. */
  readonly resolver?: (hostname: string) => Promise<readonly { address: string; family: number }[]>
}

/** A destination that passed the policy, pinned to the address it passed with. */
export interface ResolvedTarget {
  readonly url: URL
  readonly hostname: string
  readonly port: number
  /** The address we will actually connect to. Pinning this is what closes the TOCTOU. */
  readonly address: string
  readonly family: number
  /**
   * The name to send as TLS SNI, or null for an IP literal: RFC 6066 forbids an
   * address there, and certificate checks then match the address itself.
   */
  readonly serverName: string | null
}

/** TLS options naming the peer: SNI when it has a name, certificates always verified. */
export function tlsPeer(target: ResolvedTarget): { servername?: string; rejectUnauthorized: true } {
  return {
    ...(target.serverName !== null ? { servername: target.serverName } : {}),
    rejectUnauthorized: true,
  }
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 }

/** The schemes each kind of measurement speaks. */
export const HTTP_SCHEMES: readonly string[] = ['http:', 'https:']
export const WS_SCHEMES: readonly string[] = ['ws:', 'wss:']

/**
 * Which classes each profile permits.
 *
 * link-local is denied in EVERY profile including allowlist: it is how cloud
 * metadata (169.254.169.254) gets reached, and no legitimate measurement needs it.
 * unspecified (0.0.0.0, ::) is denied everywhere too — it is not a destination.
 */
const ALLOWED_CLASSES: Record<NetProfile, ReadonlySet<IpClass>> = {
  'deny-all': new Set(),
  loopback: new Set<IpClass>(['loopback']),
  private: new Set<IpClass>(['loopback', 'private']),
  allowlist: new Set<IpClass>(['loopback', 'private', 'public']),
}

/** Whether signal has aborted, read fresh at each call. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function defaultResolver(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

/**
 * `work`, or a rejection as soon as `signal` aborts.
 *
 * dns.lookup takes no signal and runs on the libuv thread pool, where a stalled
 * resolver can hold it well past any deadline. The lookup itself cannot be
 * stopped; waiting for it can. The caller checks for a signal already aborted
 * before starting the work.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/**
 * Resolve, validate every address, and pin the one we connect to.
 *
 * Steps 1-6 of 03-protocolo §5.1. Step 7 (revalidate each redirect hop) is the
 * caller's job: it calls this again for every hop, with no exceptions.
 * `schemes` is what the calling tool speaks: an https:// URL handed to a
 * WebSocket measurement would otherwise go out as plain text to port 443.
 */
export async function resolveAndValidate(
  rawUrl: string,
  policy: NetPolicy,
  signal?: AbortSignal,
  schemes: readonly string[] = [...HTTP_SCHEMES, ...WS_SCHEMES],
): Promise<Result<ResolvedTarget>> {
  const destination = parseDestination(rawUrl, schemes)
  if (!destination.ok) return destination
  const { url, hostname, port } = destination.value

  const admitted = admitByName(policy, hostname, port)
  if (!admitted.ok) return admitted

  const addresses = await resolveAddresses(hostname, policy, signal)
  if (!addresses.ok) return addresses
  if (signal?.aborted === true) {
    return Err(toolError(ErrorCodes.CANCELLED, 'cancelled before connecting'))
  }

  const chosen = checkAddresses(addresses.value, hostname, policy.profile)
  if (!chosen.ok) return chosen

  // 6. Connect to the VALIDATED address, with the original Host and SNI. Between
  //    validating and connecting there is no second resolution that could return
  //    something else.
  return Ok({
    url,
    hostname,
    port,
    address: chosen.value.address,
    family: chosen.value.family,
    serverName: isIP(hostname) === 0 ? hostname : null,
  })
}

/** 1. A parseable absolute URL in a scheme the tool speaks, with its port made explicit. */
function parseDestination(
  rawUrl: string,
  schemes: readonly string[],
): Result<{ url: URL; hostname: string; port: number }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return Err(toolError(ErrorCodes.URL_INVALID, `not a parseable absolute URL: ${rawUrl}`))
  }
  if (!schemes.includes(url.protocol)) {
    return Err(
      toolError(ErrorCodes.URL_INVALID, `unsupported scheme: ${url.protocol}`, {
        detail: { supported: [...schemes] },
      }),
    )
  }
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const port = url.port === '' ? (DEFAULT_PORTS[url.protocol] ?? 0) : Number(url.port)
  return Ok({ url, hostname, port })
}

/**
 * What the profile decides before any lookup: deny-all refuses everything, and
 * an allowlist requires an exact host:port. Neither replaces the address checks
 * that follow — an allowed name is only a promise about the name.
 */
function admitByName(policy: NetPolicy, hostname: string, port: number): Result<void> {
  if (policy.profile === 'deny-all') {
    return Err(
      toolError(ErrorCodes.HOST_NOT_ALLOWED, 'network access is denied by policy profile deny-all'),
    )
  }
  if (policy.profile === 'allowlist') {
    const key = `${hostname}:${port}`
    const allowed = policy.allowHosts ?? []
    if (!allowed.includes(key)) {
      return Err(
        toolError(ErrorCodes.HOST_NOT_ALLOWED, `${key} is not in the allowlist`, {
          detail: { allowHosts: allowed },
        }),
      )
    }
  }
  return Ok(undefined)
}

/** 2-3. A literal IP skips resolution; a name is resolved, with no cache of our own. */
async function resolveAddresses(
  hostname: string,
  policy: NetPolicy,
  signal: AbortSignal | undefined,
): Promise<Result<readonly { address: string; family: number }[]>> {
  const family = isIP(hostname)
  if (family !== 0) return Ok([{ address: hostname, family }])
  // A lookup started for a call already cancelled is work nobody will read.
  if (signal?.aborted === true) {
    return Err(toolError(ErrorCodes.CANCELLED, 'cancelled before resolving the name'))
  }

  let addresses: readonly { address: string; family: number }[]
  try {
    addresses = await untilAborted((policy.resolver ?? defaultResolver)(hostname), signal)
  } catch (e) {
    // Read again: the await above is where an abort happens.
    if (isAborted(signal)) {
      return Err(toolError(ErrorCodes.CANCELLED, 'cancelled while resolving the name'))
    }
    return Err(
      toolError(ErrorCodes.DNS_FAILURE, `could not resolve ${hostname}`, {
        cause: e,
        detail: { hostname },
      }),
    )
  }
  if (addresses.length === 0) {
    return Err(toolError(ErrorCodes.DNS_FAILURE, `${hostname} resolved to no addresses`))
  }
  return Ok(addresses)
}

/**
 * 4-5. Classifies EVERY address and refuses the destination if ANY falls
 * outside the profile — all, not any: a name with one public record and one
 * loopback is an attack. Returns the address to pin.
 */
function checkAddresses(
  addresses: readonly { address: string; family: number }[],
  hostname: string,
  profile: NetProfile,
): Result<{ address: string; family: number }> {
  const classified = addresses.map((a) => ({ ...a, class: classifyIp(a.address) }))
  const permitted = ALLOWED_CLASSES[profile]
  const offending = classified.filter((a) => !permitted.has(a.class))
  if (offending.length > 0) {
    return Err(
      toolError(
        ErrorCodes.HOST_NOT_ALLOWED,
        `${hostname} resolves to an address outside the ${profile} profile`,
        {
          detail: {
            profile,
            rejected: offending.map((a) => ({ address: a.address, class: a.class })),
            resolved: classified.map((a) => ({ address: a.address, class: a.class })),
          },
        },
      ),
    )
  }
  return Ok(classified[0]!)
}
