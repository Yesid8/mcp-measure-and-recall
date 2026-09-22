import { describe, expect, it } from 'vitest'
import { decodePayload, mapSocketError } from '../../src/tools/wire.js'

function errno(code: string | undefined, message = 'boom'): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException
  if (code !== undefined) e.code = code
  return e
}

describe('mapSocketError gives each socket failure one stable code', () => {
  it.each([
    ['ECONNREFUSED', 'CONNECTION_REFUSED'],
    ['ENOTFOUND', 'DNS_FAILURE'],
    ['EAI_AGAIN', 'DNS_FAILURE'],
    ['ETIMEDOUT', 'TIMEOUT'],
    ['ECONNRESET', 'CONNECTION_RESET'],
    ['EPIPE', 'CONNECTION_RESET'],
    ['ABORT_ERR', 'CANCELLED'],
    ['EHOSTUNREACH', 'HOST_UNREACHABLE'],
    ['ENETUNREACH', 'HOST_UNREACHABLE'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_ERROR'],
    ['CERT_HAS_EXPIRED', 'TLS_ERROR'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_ERROR'],
  ])('%s -> %s', (code, expected) => {
    expect(mapSocketError(errno(code)).code).toBe(expected)
  })

  it('recognises a TLS failure by its message when the code says nothing', () => {
    expect(mapSocketError(errno(undefined, 'unable to verify the first certificate')).code).toBe(
      'TLS_ERROR',
    )
  })

  it('falls back to CONNECTION_FAILED, keeping the original message', () => {
    const err = mapSocketError(errno('EWHATEVER', 'something odd'))
    expect(err.code).toBe('CONNECTION_FAILED')
    expect(err.message).toBe('something odd')
  })

  it('keeps the original error as cause, which goes to the log only', () => {
    const original = errno('ECONNRESET')
    expect(mapSocketError(original).cause).toBe(original)
  })
})

describe('decodePayload describes encoding, never meaning', () => {
  it('parses text that is JSON', () => {
    expect(decodePayload(Buffer.from('{"a":1}'), true)).toEqual({
      payload: { a: 1 },
      format: 'json',
    })
  })

  it('keeps text that is not JSON verbatim', () => {
    expect(decodePayload(Buffer.from('plain words'), true)).toEqual({
      payload: 'plain words',
      format: 'text',
    })
  })

  it('base64-encodes binary instead of decoding it lossily', () => {
    const bytes = Buffer.from([0xff, 0x00, 0x80])
    expect(decodePayload(bytes, false)).toEqual({
      payload: bytes.toString('base64'),
      format: 'base64',
    })
  })
})
