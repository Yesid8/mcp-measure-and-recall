import type { NetPolicy, NetProfile } from './policy/net.js'
import { Err, ErrorCodes, Ok, toolError, type Result } from './kernel/result.js'
import { DEFAULT_MAX_REDIRECTS } from './tools/measure-http.js'
import { DEFAULT_STALE_SECONDS } from './tools/recall.js'

/**
 * Operator configuration, read from the environment once at startup.
 *
 * Everything here widens or narrows what the server may do, so nothing is
 * guessed: a value that does not parse stops the server with a message naming
 * the variable, rather than falling back to a default the operator did not ask
 * for. No tool argument can change any of it.
 */

/** What the environment configures. */
export interface Config {
  readonly policy: NetPolicy
  /** recall.* stale threshold when the caller gives none. */
  readonly defaultStaleSeconds: number
}

export const CONFIG_INVALID = ErrorCodes.CONFIG_INVALID

const PROFILES: readonly NetProfile[] = ['deny-all', 'loopback', 'private', 'allowlist']

const MAX_REDIRECTS_CAP = 20

/**
 * `host:port`, with an IPv6 host in brackets. Host characters are letters,
 * digits, `-` and `.` only: a URL parser accepts `*.example.com` as a name, and
 * an operator who wrote it would believe they had a wildcard that never matches.
 */
const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[\p{L}\p{N}.-]+):(\d{1,5})$/u

function invalid(variable: string, message: string): Result<never> {
  return Err(toolError(CONFIG_INVALID, `${variable}: ${message}`, { detail: { variable } }))
}

/** Unset and empty are the same: "use the default". */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim()
  return v === undefined || v.length === 0 ? undefined : v
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): Result<number> {
  const raw = read(env, name)
  if (raw === undefined) return Ok(fallback)
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    return invalid(name, `expected an integer from ${min} to ${max}, got "${raw}"`)
  }
  return Ok(Number(raw))
}

/**
 * Normalizes one allowlist entry to the key the policy compares against: the
 * hostname as a URL parser writes it (lower case, punycode, IPv6 without
 * brackets) and an explicit port.
 */
function allowEntry(entry: string): string | null {
  const m = HOST_PORT.exec(entry)
  if (m === null) return null
  const port = Number(m[2])
  if (port < 1 || port > 65535) return null
  let hostname: string
  try {
    hostname = new URL(`http://${m[1]}`).hostname
  } catch {
    return null
  }
  if (hostname.startsWith('[')) hostname = hostname.slice(1, -1)
  return `${hostname}:${port}`
}

/**
 * Reads the configuration from `env`.
 *
 * - `PLINTH_FACTS_NET_PROFILE`: `deny-all`, `loopback` (default), `private`
 *   or `allowlist`.
 * - `PLINTH_FACTS_ALLOW_HOSTS`: comma-separated `host:port` pairs. Required by
 *   `allowlist` and refused by every other profile, where it would be silently
 *   ignored. The only way to reach a public address.
 * - `PLINTH_FACTS_MAX_REDIRECTS`: hops a caller may ask to follow, 0-20 (5).
 * - `PLINTH_FACTS_DEFAULT_STALE_SECONDS`: default stale threshold (3600).
 *
 * PLINTH_DATA_DIR is read by the store, where the path is resolved.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<Config> {
  const profileRaw = read(env, 'PLINTH_FACTS_NET_PROFILE') ?? 'loopback'
  if (!PROFILES.includes(profileRaw as NetProfile)) {
    return invalid(
      'PLINTH_FACTS_NET_PROFILE',
      `expected one of ${PROFILES.join(', ')}, got "${profileRaw}"`,
    )
  }
  const profile = profileRaw as NetProfile

  const hostsRaw = read(env, 'PLINTH_FACTS_ALLOW_HOSTS')
  const allowHosts: string[] = []
  if (hostsRaw !== undefined) {
    if (profile !== 'allowlist') {
      return invalid(
        'PLINTH_FACTS_ALLOW_HOSTS',
        `only applies to PLINTH_FACTS_NET_PROFILE=allowlist, and the profile is ${profile}`,
      )
    }
    for (const entry of hostsRaw.split(',').map((s) => s.trim())) {
      if (entry.length === 0) continue
      const key = allowEntry(entry)
      if (key === null) {
        return invalid(
          'PLINTH_FACTS_ALLOW_HOSTS',
          `"${entry}" is not host:port — every entry needs an explicit port, and wildcards are not accepted`,
        )
      }
      if (!allowHosts.includes(key)) allowHosts.push(key)
    }
  }
  if (profile === 'allowlist' && allowHosts.length === 0) {
    return invalid('PLINTH_FACTS_ALLOW_HOSTS', 'the allowlist profile needs at least one host:port')
  }

  const maxRedirects = integer(
    env,
    'PLINTH_FACTS_MAX_REDIRECTS',
    DEFAULT_MAX_REDIRECTS,
    0,
    MAX_REDIRECTS_CAP,
  )
  if (!maxRedirects.ok) return maxRedirects

  const stale = integer(
    env,
    'PLINTH_FACTS_DEFAULT_STALE_SECONDS',
    DEFAULT_STALE_SECONDS,
    0,
    Number.MAX_SAFE_INTEGER,
  )
  if (!stale.ok) return stale

  return Ok({
    policy: {
      profile,
      maxRedirects: maxRedirects.value,
      ...(profile === 'allowlist' ? { allowHosts } : {}),
    },
    defaultStaleSeconds: stale.value,
  })
}

/** One line for server/discover: the model should know where it measures from. */
export function describePolicy(policy: NetPolicy): string {
  switch (policy.profile) {
    case 'deny-all':
      return 'Network policy: deny-all. measure.* refuses every destination.'
    case 'loopback':
      return 'Network policy: loopback. measure.* reaches only services on this machine.'
    case 'private':
      return 'Network policy: private. measure.* reaches this machine and private-network addresses (RFC 1918, fc00::/7), never public ones.'
    case 'allowlist':
      return `Network policy: allowlist. measure.* reaches exactly these host:port pairs: ${(policy.allowHosts ?? []).join(', ')}.`
  }
}
