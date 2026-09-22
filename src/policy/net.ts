import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { classifyIp, type IpClass } from './ip.js'
import { CoreErrors, Err, Ok, toolError, type Result } from '../kernel/result.js'

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

function defaultResolver(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

/**
 * `work`, or a rejection as soon as `signal` aborts.
 *
 * dns.lookup takes no signal and runs on the libuv thread pool, where a stalled
 * resolver can hold it well past any deadline. The lookup itself cannot be
 * stopped; waiting for it can.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
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
  // 1.
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return Err(toolError('URL_INVALID', `not a parseable absolute URL: ${rawUrl}`))
  }
  if (!schemes.includes(url.protocol)) {
    return Err(
      toolError('URL_INVALID', `unsupported scheme: ${url.protocol}`, {
        detail: { supported: [...schemes] },
      }),
    )
  }

  if (policy.profile === 'deny-all') {
    return Err(
      toolError(CoreErrors.HOST_NOT_ALLOWED, 'network access is denied by policy profile deny-all'),
    )
  }

  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const port = url.port === '' ? (DEFAULT_PORTS[url.protocol] ?? 0) : Number(url.port)

  // allowlist requires an exact host:port match before anything else happens.
  if (policy.profile === 'allowlist') {
    const key = `${hostname}:${port}`
    const allowed = policy.allowHosts ?? []
    if (!allowed.includes(key)) {
      return Err(
        toolError(CoreErrors.HOST_NOT_ALLOWED, `${key} is not in the allowlist`, {
          detail: { allowHosts: allowed },
        }),
      )
    }
  }

  // 2-3. A literal IP skips resolution; a name is resolved (no cache of our own).
  let addresses: readonly { address: string; family: number }[]
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  } else {
    const resolver = policy.resolver ?? defaultResolver
    try {
      addresses = await untilAborted(resolver(hostname), signal)
    } catch (e) {
      if (signal?.aborted === true) {
        return Err(toolError(CoreErrors.CANCELLED, 'cancelled while resolving the name'))
      }
      return Err(
        toolError('DNS_FAILURE', `could not resolve ${hostname}`, {
          cause: e,
          detail: { hostname },
        }),
      )
    }
    if (addresses.length === 0) {
      return Err(toolError('DNS_FAILURE', `${hostname} resolved to no addresses`))
    }
  }
  if (signal?.aborted === true) {
    return Err(toolError(CoreErrors.CANCELLED, 'cancelled before connecting'))
  }

  // 4. Classify EVERY address.
  const classified = addresses.map((a) => ({ ...a, class: classifyIp(a.address) }))

  // 5. If ANY address falls outside the profile, refuse without opening a socket.
  //    All, not any: a name with one public A record and one loopback is an attack.
  const permitted = ALLOWED_CLASSES[policy.profile]
  const offending = classified.filter((a) => !permitted.has(a.class))
  if (offending.length > 0) {
    return Err(
      toolError(
        CoreErrors.HOST_NOT_ALLOWED,
        `${hostname} resolves to an address outside the ${policy.profile} profile`,
        {
          detail: {
            profile: policy.profile,
            rejected: offending.map((a) => ({ address: a.address, class: a.class })),
            resolved: classified.map((a) => ({ address: a.address, class: a.class })),
          },
        },
      ),
    )
  }

  // 6. Connect to the VALIDATED address, with the original Host and SNI. Between
  //    validating and connecting there is no second resolution that could return
  //    something else.
  const chosen = classified[0]!
  return Ok({
    url,
    hostname,
    port,
    address: chosen.address,
    family: chosen.family,
  })
}
