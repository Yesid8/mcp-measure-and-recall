import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describePolicy, loadConfig } from '../../src/config.js'
import { httpFixture, type HttpFixture } from '../fixtures/http.js'
import { inProcessClient, readToolResult, type TestClient } from '../fixtures/client.js'

const ok = (env: Record<string, string>) => {
  const r = loadConfig(env)
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const refused = (env: Record<string, string>) => {
  const r = loadConfig(env)
  if (r.ok) throw new Error('expected the configuration to be refused')
  return r.error
}

describe('loadConfig', () => {
  it('defaults to loopback, five redirects and an hour', () => {
    expect(ok({})).toEqual({
      policy: { profile: 'loopback', maxRedirects: 5 },
      defaultStaleSeconds: 3600,
    })
  })

  it('treats an empty variable as unset', () => {
    expect(ok({ PLINTH_FACTS_NET_PROFILE: '  ' }).policy.profile).toBe('loopback')
  })

  it.each(['deny-all', 'loopback', 'private'])('accepts the %s profile', (profile) => {
    expect(ok({ PLINTH_FACTS_NET_PROFILE: profile }).policy.profile).toBe(profile)
  })

  it('normalizes allowlist entries to what the policy compares', () => {
    const { policy } = ok({
      PLINTH_FACTS_NET_PROFILE: 'allowlist',
      PLINTH_FACTS_ALLOW_HOSTS:
        ' API.Example.com:443 , [::1]:8080,api.example.com:443,, 10.0.0.5:80 ',
    })
    expect(policy.allowHosts).toEqual(['api.example.com:443', '::1:8080', '10.0.0.5:80'])
  })

  it('names the variable when it refuses a value', () => {
    const error = refused({ PLINTH_FACTS_NET_PROFILE: 'public' })
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('PLINTH_FACTS_NET_PROFILE')
  })

  it.each(['example.com', '*.example.com:443', 'example.com:0', 'example.com:70000', 'a b:80'])(
    'refuses the allowlist entry %s',
    (entry) => {
      const error = refused({
        PLINTH_FACTS_NET_PROFILE: 'allowlist',
        PLINTH_FACTS_ALLOW_HOSTS: entry,
      })
      expect(error.message).toContain('PLINTH_FACTS_ALLOW_HOSTS')
    },
  )

  it('refuses an allowlist with no hosts', () => {
    expect(refused({ PLINTH_FACTS_NET_PROFILE: 'allowlist' }).message).toContain(
      'at least one host:port',
    )
  })

  it('refuses hosts under a profile that would silently ignore them', () => {
    expect(refused({ PLINTH_FACTS_ALLOW_HOSTS: 'example.com:443' }).message).toContain(
      'only applies to',
    )
  })

  it.each([
    ['PLINTH_FACTS_MAX_REDIRECTS', '21'],
    ['PLINTH_FACTS_MAX_REDIRECTS', '-1'],
    ['PLINTH_FACTS_MAX_REDIRECTS', '2.5'],
    ['PLINTH_FACTS_DEFAULT_STALE_SECONDS', 'soon'],
  ])('refuses %s=%s', (name, value) => {
    expect(refused({ [name]: value }).message).toContain(name)
  })

  it('reads the redirect cap and the stale threshold', () => {
    const c = ok({ PLINTH_FACTS_MAX_REDIRECTS: '0', PLINTH_FACTS_DEFAULT_STALE_SECONDS: '60' })
    expect(c.policy.maxRedirects).toBe(0)
    expect(c.defaultStaleSeconds).toBe(60)
  })
})

describe('describePolicy', () => {
  it.each([
    [{ profile: 'deny-all' as const }, 'refuses every destination'],
    [{ profile: 'loopback' as const }, 'only services on this machine'],
    [{ profile: 'private' as const }, 'never public ones'],
    [{ profile: 'allowlist' as const, allowHosts: ['a.test:443'] }, 'a.test:443'],
  ])('states the %j profile', (policy, text) => {
    expect(describePolicy(policy)).toContain(text)
  })
})

describe('an allowlist server, end to end', () => {
  let fx: HttpFixture
  let other: HttpFixture
  let client: TestClient

  afterEach(async () => {
    await client.closeAsync()
    await fx.close()
    await other.close()
  })

  it('measures the listed host:port, refuses any other, and says so in discover', async () => {
    fx = await httpFixture()
    other = await httpFixture()
    const { policy } = ok({
      PLINTH_FACTS_NET_PROFILE: 'allowlist',
      PLINTH_FACTS_ALLOW_HOSTS: new URL(fx.origin).host,
    })
    client = inProcessClient({ dataDir: mkdtempSync(join(tmpdir(), 'plinth-allow-')), policy })

    const measure = async (origin: string) =>
      readToolResult(
        await client.request('tools/call', {
          name: 'facts.measure.http',
          arguments: { project: 'p', url: `${origin}/ok` },
        }),
      )
    expect((await measure(fx.origin)).isError).toBe(false)
    const denied = await measure(other.origin)
    expect((denied.envelope['error'] as { code: string }).code).toBe('HOST_NOT_ALLOWED')

    const discover = (await client.request('server/discover', {}, null)) as unknown as {
      result: { instructions: string }
    }
    expect(discover.result.instructions).toContain(`allowlist`)
    expect(discover.result.instructions).toContain(new URL(fx.origin).host)
  })
})
