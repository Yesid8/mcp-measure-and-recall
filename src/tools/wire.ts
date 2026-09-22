import { CoreErrors, toolError, type ToolError } from '../kernel/result.js'

/**
 * Shared decoding for the measure.* tools.
 *
 * Both HTTP and WebSocket turn socket failures into errors and raw bytes into a
 * described payload. Keeping one implementation is not only about duplication:
 * two copies drift, and a caller that sees CONNECTION_RESET from one tool and a
 * generic failure from the other cannot tell whether the difference is in the
 * network or in us.
 */

/**
 * Maps a socket-level failure to a stable error code.
 *
 * These are failures to observe, never observations of failure: a service that
 * answers 500 does not come through here.
 */
export function mapSocketError(e: NodeJS.ErrnoException): ToolError {
  switch (e.code) {
    case 'ECONNREFUSED':
      return toolError('CONNECTION_REFUSED', 'nothing is listening on that address and port', {
        cause: e,
      })
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return toolError('DNS_FAILURE', 'the host could not be resolved', { cause: e })
    case 'ETIMEDOUT':
      return toolError(CoreErrors.TIMEOUT, 'the connection timed out', { cause: e })
    case 'ECONNRESET':
      return toolError('CONNECTION_RESET', 'the connection was reset by the peer', { cause: e })
    case 'EPIPE':
      return toolError('CONNECTION_RESET', 'the connection closed while writing', { cause: e })
    case 'ABORT_ERR':
      return toolError(CoreErrors.CANCELLED, 'the call was cancelled', { cause: e })
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return toolError('HOST_UNREACHABLE', 'no route to that address', { cause: e })
    default:
      if (isTlsFailure(e)) {
        return toolError('TLS_ERROR', `TLS handshake failed: ${e.message}`, { cause: e })
      }
      return toolError('CONNECTION_FAILED', e.message, { cause: e })
  }
}

/** Node reports TLS failures through codes and messages rather than one errno. */
function isTlsFailure(e: NodeJS.ErrnoException): boolean {
  const code = e.code ?? ''
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.startsWith('DEPTH_ZERO')) {
    return true
  }
  return /certificate|SSL|TLS handshake/i.test(e.message)
}

export type PayloadFormat = 'json' | 'text' | 'base64'

/**
 * Describes how bytes were encoded — never what they mean.
 *
 * Text that parses as JSON comes back parsed, because a caller comparing two
 * observations wants structure rather than a string; text that does not stays
 * verbatim. Binary goes to base64 rather than lossy UTF-8 decoding.
 */
export function decodePayload(
  buf: Buffer,
  isText: boolean,
): { payload: unknown; format: PayloadFormat } {
  if (!isText) return { payload: buf.toString('base64'), format: 'base64' }
  const text = buf.toString('utf8')
  try {
    return { payload: JSON.parse(text) as unknown, format: 'json' }
  } catch {
    return { payload: text, format: 'text' }
  }
}
