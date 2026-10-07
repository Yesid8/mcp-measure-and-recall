import { describe, expect, it } from 'vitest'
import {
  HTTP_SCHEMES,
  resolveAndValidate,
  tlsPeer,
  WS_SCHEMES,
  type NetPolicy,
} from '../../src/policy/net.js'
import { classifyIp } from '../../src/policy/ip.js'

const resolver =
  (map: Record<string, { address: string; family: number }[]>) => async (host: string) => {
    const entry = map[host]
    if (entry === undefined) throw new Error(`ENOTFOUND ${host}`)
    return entry
  }

describe('classifyIp accepts every textual form of an address', () => {
  it.each([
    ['[::1]', 'loopback'], // bracketed, as in a URL
    ['fe80::1%eth0', 'link-local'], // zone index
    ['::127.0.0.1', 'loopback'], // IPv4-compatible
    ['::ffff:10.0.0.1', 'private'], // IPv4-mapped private
    ['FC00::1', 'private'], // upper case
    ['2001:db8::1', 'public'],
    ['2001:db8:0:0:0:0:0:1', 'public'], // uncompressed
    ['::ffff:c0a8:101', 'private'], // IPv4-mapped written in hex: 192.168.1.1
    ['::ffff:7f00:1', 'loopback'], // IPv4-mapped written in hex: 127.0.0.1
    ['::0.1.2.3', 'unspecified'], // IPv4-compatible form of 0.0.0.0/8
  ])('%s is %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected)
  })

  it.each([
    ['0.1.2.3', 'unspecified'], // all of 0.0.0.0/8, not only 0.0.0.0
    ['169.253.255.255', 'public'],
    ['169.255.0.1', 'public'],
    ['172.15.255.255', 'public'],
    ['192.167.255.255', 'public'],
    ['192.169.0.1', 'public'],
    ['100.63.255.255', 'public'],
    ['11.0.0.1', 'public'],
    ['fd00::1', 'private'], // fc00::/7 covers fd00::/8, the half actually in use
    ['fbff::1', 'public'],
    ['fe80::', 'link-local'],
    ['febf::1', 'link-local'], // last /16 inside fe80::/10
    ['fec0::1', 'public'], // first outside it
  ])('%s sits on the right side of its range boundary: %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected)
  })

  it.each(['not-an-ip', '256.1.1.1', '1.2.3', ''])(
    '%s is not an IP and classifies as public, the class narrow profiles refuse',
    (address) => {
      expect(classifyIp(address)).toBe('public')
    },
  )
})

describe('resolveAndValidate', () => {
  const loopback: NetPolicy = { profile: 'loopback' }

  it('reports a name that does not resolve as DNS_FAILURE', async () => {
    const r = await resolveAndValidate('http://nowhere.test/', {
      ...loopback,
      resolver: resolver({}),
    })
    expect(!r.ok && r.error.code).toBe('DNS_FAILURE')
  })

  it('reports a name that resolves to nothing as DNS_FAILURE', async () => {
    const r = await resolveAndValidate('http://empty.test/', {
      ...loopback,
      resolver: resolver({ 'empty.test': [] }),
    })
    expect(!r.ok && r.error.code).toBe('DNS_FAILURE')
  })

  it('stops before connecting when the call was cancelled during resolution', async () => {
    const c = new AbortController()
    c.abort()
    const r = await resolveAndValidate('http://127.0.0.1:1/', loopback, c.signal)
    expect(!r.ok && r.error.code).toBe('CANCELLED')
  })

  it('stops waiting for a resolver that never answers once the call is cancelled', async () => {
    const c = new AbortController()
    setTimeout(() => c.abort(), 20)
    const started = performance.now()
    const r = await resolveAndValidate(
      'http://hangs.test/',
      { ...loopback, resolver: () => new Promise(() => {}) },
      c.signal,
    )
    expect(!r.ok && r.error.code).toBe('CANCELLED')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('does not start a lookup for a call already cancelled', async () => {
    const c = new AbortController()
    c.abort()
    let asked = false
    const r = await resolveAndValidate(
      'http://name.test/',
      { ...loopback, resolver: async () => ((asked = true), []) },
      c.signal,
    )
    expect(!r.ok && r.error.code).toBe('CANCELLED')
    expect(asked).toBe(false)
  })

  it('reports a failed lookup as DNS_FAILURE while a signal is attached', async () => {
    const r = await resolveAndValidate(
      'http://nowhere.test/',
      { ...loopback, resolver: resolver({}) },
      new AbortController().signal,
    )
    expect(!r.ok && r.error.code).toBe('DNS_FAILURE')
  })

  it.each([
    ['ws://127.0.0.1/', HTTP_SCHEMES],
    ['https://127.0.0.1/', WS_SCHEMES],
  ])('refuses %s to a tool that does not speak that scheme', async (url, schemes) => {
    const r = await resolveAndValidate(url, loopback, undefined, schemes)
    expect(!r.ok && r.error.code).toBe('URL_INVALID')
  })

  it('rejects a string that is not a URL', async () => {
    const r = await resolveAndValidate('not a url', loopback)
    expect(!r.ok && r.error.code).toBe('URL_INVALID')
  })

  it.each([
    ['http://127.0.0.1/', 80],
    ['https://127.0.0.1/', 443],
    ['ws://127.0.0.1/', 80],
    ['wss://127.0.0.1/', 443],
    ['http://127.0.0.1:8080/', 8080],
  ])('%s targets port %i', async (url, port) => {
    const r = await resolveAndValidate(url, loopback)
    expect(r.ok && r.value.port).toBe(port)
  })

  it('sends SNI for a name, and none for an IP literal (RFC 6066)', async () => {
    const named = await resolveAndValidate('https://app.localhost/', {
      ...loopback,
      resolver: resolver({ 'app.localhost': [{ address: '127.0.0.1', family: 4 }] }),
    })
    expect(named.ok && tlsPeer(named.value)).toEqual({
      servername: 'app.localhost',
      rejectUnauthorized: true,
    })
    const literal = await resolveAndValidate('https://127.0.0.1/', loopback)
    expect(literal.ok && tlsPeer(literal.value)).toEqual({ rejectUnauthorized: true })
  })

  it('pins a bracketed IPv6 literal without brackets', async () => {
    const r = await resolveAndValidate('http://[::1]:9000/', loopback)
    expect(r.ok && r.value.address).toBe('::1')
    expect(r.ok && r.value.family).toBe(6)
  })

  it('pins the resolved address while keeping the name for Host and SNI', async () => {
    const r = await resolveAndValidate('http://app.localhost:3000/x', {
      ...loopback,
      resolver: resolver({ 'app.localhost': [{ address: '127.0.0.1', family: 4 }] }),
    })
    expect(r.ok && r.value.address).toBe('127.0.0.1')
    expect(r.ok && r.value.hostname).toBe('app.localhost')
  })

  it('lets the private profile reach RFC 1918 but not the internet', async () => {
    const policy: NetPolicy = { profile: 'private' }
    expect((await resolveAndValidate('http://10.1.2.3/', policy)).ok).toBe(true)
    expect((await resolveAndValidate('http://192.168.0.10/', policy)).ok).toBe(true)
    expect((await resolveAndValidate('http://8.8.8.8/', policy)).ok).toBe(false)
  })

  it('refuses the unspecified address under every profile', async () => {
    for (const profile of ['loopback', 'private', 'allowlist'] as const) {
      const r = await resolveAndValidate('http://0.0.0.0:80/', {
        profile,
        allowHosts: ['0.0.0.0:80'],
      })
      expect(r.ok, profile).toBe(false)
    }
  })
})
