import { describe, expect, it } from 'vitest'
import {
  containsRedaction,
  redact,
  redactText,
  redactedMarker,
  stripSecretKeys,
} from '../../src/kernel/redact.js'
import { normalizeProject } from '../../src/kernel/project.js'

// Assembled at runtime so no secret scanner mistakes the fixtures for leaked keys.
const FAKE_AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const FAKE_PEM = [
  '-----BEGIN RSA PRIVATE',
  'KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE',
  'KEY-----',
].join(' ')

describe('redactText catches each secret pattern inside free text', () => {
  it.each([
    ['a bearer token', 'Authorization: Bearer abcdef0123456789', 'abcdef0123456789'],
    [
      'a JWT',
      'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'dozjgNryP4J3jVmNHl0w5N',
    ],
    ['an OpenAI-style key', 'key sk-abcdefghijklmnop1234', 'sk-abcdefghijklmnop1234'],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrst1234', 'ghp_abcdefghijklmnopqrst1234'],
    ['an AWS access key', FAKE_AWS_KEY, FAKE_AWS_KEY],
    // AIza followed by exactly 35 characters.
    ['a Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSyA1234567890'],
    ['URL credentials', 'postgres://admin:hunter2@db:5432/x', 'hunter2'],
    ['a PEM private key', FAKE_PEM, 'MIIEpAIBAAKCAQEA'],
  ])('%s', (_label, text, secret) => {
    expect(redactText(text)).not.toContain(secret)
  })

  it('leaves text without secrets unchanged', () => {
    expect(redactText('GET /api/orders returned 200')).toBe('GET /api/orders returned 200')
  })

  it('keeps the length of what it hides, which helps diagnosis', () => {
    expect(redactedMarker('ñ')).toBe('[redacted:2 bytes]') // bytes, not characters
  })

  it('replaces only the userinfo of a URL, keeping scheme, host and path', () => {
    expect(redactText('see https://alice:pw@example.test/x')).toBe(
      'see https://[redacted:8 bytes]@example.test/x',
    )
  })

  it.each([
    ['?token=abc123', '?token=[redacted:6 bytes]'],
    ['?x=1&api_key=k1&y=2', '?x=1&api_key=[redacted:2 bytes]&y=2'],
    ['?access%5Ftoken=zz', '?access%5Ftoken=[redacted:2 bytes]'], // an encoded key
    ['?max_tokens=100&page=2', '?max_tokens=100&page=2'], // mentions a token, is not one
    ['?token=', '?token='], // nothing to hide
  ])('redacts query parameters named like a secret: %s', (query, expected) => {
    expect(redactText(`https://example.test/p${query}`)).toBe(`https://example.test/p${expected}`)
  })

  it('is idempotent: a marker redacted again keeps its original length', () => {
    const once = redact({ authorization: 'Bearer abcdef0123456789', url: 'https://h/?token=abc' })
    expect(redact(once)).toEqual(once)
  })
})

describe('containsRedaction', () => {
  it.each([
    ['[redacted:12 bytes]', true],
    ['prefix [redacted] suffix', true],
    ['[redacted: depth limit]', true],
    ['redacted', false],
    ['[redacted:many bytes]', false],
  ])('%s → %s', (text, expected) => {
    expect(containsRedaction(text)).toBe(expected)
  })
})

describe('redact walks structures without mutating them', () => {
  it('does not modify its input', () => {
    const input = { headers: { authorization: 'Bearer abcdef0123456789' } }
    const copy = structuredClone(input)
    redact(input)
    expect(input).toEqual(copy)
  })

  it('passes non-string scalars and null through', () => {
    expect(redact({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null })
  })

  it('redacts inside arrays', () => {
    expect(JSON.stringify(redact(['Bearer abcdef0123456789']))).not.toContain('abcdef')
  })

  it('keeps null and undefined under a secret key as they are', () => {
    expect(redact({ password: null })).toEqual({ password: null })
  })

  it('replaces a number under a secret key', () => {
    expect(redact({ pin_secret: 1234 })).toEqual({ pin_secret: '[redacted]' })
  })
})

describe('stripSecretKeys drops credentials instead of masking them', () => {
  it('keeps ordinary headers and removes secret ones entirely', () => {
    expect(
      stripSecretKeys({ accept: 'application/json', Authorization: 'Bearer x', 'x-api-key': 'k' }),
    ).toEqual({ accept: 'application/json' })
  })
})

describe('normalizeProject bounds', () => {
  it('accepts exactly 64 characters', () => {
    expect(normalizeProject('a'.repeat(64)).ok).toBe(true)
  })

  it('refuses 65 characters, and says how long it was', () => {
    const r = normalizeProject('a'.repeat(65))
    expect(!r.ok && r.error.code).toBe('INVALID_PROJECT')
    expect(!r.ok && r.error.message).toContain('65')
  })

  it('trims whitespace and collapses separators', () => {
    const r = normalizeProject('  Mi   Proyecto / v2  ')
    expect(r.ok && r.value).toBe('mi-proyecto-v2')
  })
})
