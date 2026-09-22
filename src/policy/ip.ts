import { isIP, isIPv4 } from 'node:net'

/**
 * IP classification.
 *
 * The policy judges the resolved ADDRESS, never the name: a name is not a
 * destination. A filter on names has three ways through it — DNS rebinding
 * (evil.localhost resolving to a public address, or to loopback and then to a
 * public one between the check and the connection), redirects, and cloud
 * metadata at 169.254.169.254, which is link-local and so "not remote" to any
 * naive list, yet the first stop of any exfiltration from a container.
 */

export type IpClass = 'loopback' | 'private' | 'link-local' | 'cgnat' | 'public' | 'unspecified'

/** Strips an IPv6 zone index (fe80::1%eth0) and brackets. */
function bare(address: string): string {
  const noBrackets =
    address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const pct = noBrackets.indexOf('%')
  return pct === -1 ? noBrackets : noBrackets.slice(0, pct)
}

function ipv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) return NaN
    return Number(p)
  })
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

function classifyV4(address: string): IpClass {
  const o = ipv4Octets(address)
  if (o === null) return 'public'
  const [a, b] = o
  if (a === 0) return 'unspecified' // 0.0.0.0/8 — "this host"; routes to loopback on Linux
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local' // includes 169.254.169.254
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat' // 100.64.0.0/10
  return 'public'
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function v6Groups(address: string): number[] | null {
  const addr = address.toLowerCase()
  const halves = addr.split('::')
  if (halves.length > 2) return null

  const parse = (s: string): number[] | null => {
    if (s.length === 0) return []
    const out: number[] = []
    for (const part of s.split(':')) {
      if (part.includes('.')) {
        // IPv4-mapped tail, e.g. ::ffff:127.0.0.1
        const o = ipv4Octets(part)
        if (o === null) return null
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(Number.parseInt(part, 16))
    }
    return out
  }

  if (halves.length === 1) {
    const g = parse(halves[0]!)
    return g !== null && g.length === 8 ? g : null
  }
  const head = parse(halves[0]!)
  const tail = parse(halves[1]!)
  if (head === null || tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...Array<number>(fill).fill(0), ...tail]
}

function classifyV6(address: string): IpClass {
  const g = v6Groups(address)
  if (g === null) return 'public'

  const allZero = g.every((x) => x === 0)
  if (allZero) return 'unspecified' // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback' // ::1

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: classify by the embedded v4,
  // or ::ffff:127.0.0.1 would read as "public" and walk straight through.
  const isMapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff
  const isCompat = g.slice(0, 6).every((x) => x === 0) && (g[6] !== 0 || g[7] !== 0)
  if (isMapped || isCompat) {
    const a = (g[6]! >> 8) & 0xff
    const b = g[6]! & 0xff
    const c = (g[7]! >> 8) & 0xff
    const d = g[7]! & 0xff
    return classifyV4(`${a}.${b}.${c}.${d}`)
  }

  const first = g[0]!
  if ((first & 0xffc0) === 0xfe80) return 'link-local' // fe80::/10
  if ((first & 0xfe00) === 0xfc00) return 'private' // fc00::/7 unique local
  return 'public'
}

/**
 * The class of an IPv4 or IPv6 literal, brackets and zone index allowed.
 * Anything that is not an IP literal classifies as 'public', the class the
 * narrowest profiles refuse.
 */
export function classifyIp(address: string): IpClass {
  const addr = bare(address)
  const version = isIP(addr)
  if (version === 0) return 'public' // not an IP: treated as the strictest option
  return isIPv4(addr) ? classifyV4(addr) : classifyV6(addr)
}
