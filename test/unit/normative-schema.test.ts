import { describe, expect, it } from 'vitest'
import type * as Spec from '../../vendor/mcp-schema-2026-07-28.js'
import * as Wire from '../../src/protocol/jsonrpc.js'

/**
 * The vendored normative schema as an oracle.
 *
 * The protocol is implemented by hand (ADR-0001, ADR-0002), so nothing stops
 * one of its constants drifting from the revision it claims to speak. Each
 * `satisfies` below is checked by `tsc`: change a code or a `_meta` key in
 * src/protocol/jsonrpc.ts and the typecheck fails here, before any test runs.
 */
const pinned = {
  version: Wire.LATEST_PROTOCOL_VERSION satisfies typeof Spec.LATEST_PROTOCOL_VERSION,
  jsonrpc: Wire.JSONRPC_VERSION satisfies typeof Spec.JSONRPC_VERSION,
  parseError: Wire.PARSE_ERROR satisfies typeof Spec.PARSE_ERROR,
  invalidRequest: Wire.INVALID_REQUEST satisfies typeof Spec.INVALID_REQUEST,
  methodNotFound: Wire.METHOD_NOT_FOUND satisfies typeof Spec.METHOD_NOT_FOUND,
  invalidParams: Wire.INVALID_PARAMS satisfies typeof Spec.INVALID_PARAMS,
  internalError: Wire.INTERNAL_ERROR satisfies typeof Spec.INTERNAL_ERROR,
  headerMismatch: Wire.HEADER_MISMATCH satisfies typeof Spec.HEADER_MISMATCH,
  missingCapability:
    Wire.MISSING_REQUIRED_CLIENT_CAPABILITY satisfies typeof Spec.MISSING_REQUIRED_CLIENT_CAPABILITY,
  unsupportedVersion:
    Wire.UNSUPPORTED_PROTOCOL_VERSION satisfies typeof Spec.UNSUPPORTED_PROTOCOL_VERSION,
  protocolVersionKey: Wire.MetaKeys.protocolVersion satisfies keyof Spec.RequestMetaObject,
  clientCapabilitiesKey: Wire.MetaKeys.clientCapabilities satisfies keyof Spec.RequestMetaObject,
  clientInfoKey: Wire.MetaKeys.clientInfo satisfies keyof Spec.RequestMetaObject,
  logLevelKey: Wire.MetaKeys.logLevel satisfies keyof Spec.RequestMetaObject,
  progressTokenKey: Wire.MetaKeys.progressToken satisfies keyof Spec.RequestMetaObject,
  serverInfoKey: Wire.MetaKeys.serverInfo satisfies keyof Spec.ResultMetaObject,
}

describe('the wire constants match the normative schema', () => {
  it('is enforced at compile time; this only keeps the file a test', () => {
    expect(Object.values(pinned).every((v) => v !== undefined)).toBe(true)
  })

  it('speaks only the revision it was written against', () => {
    expect(Wire.SUPPORTED_PROTOCOL_VERSIONS).toEqual([pinned.version])
  })
})
