/**
 * JSON-RPC 2.0 types and error codes for MCP 2026-07-28.
 *
 * Mirrors vendor/mcp-schema-2026-07-28.ts, the normative schema. The wire format
 * is implemented here rather than through @modelcontextprotocol/server; ADR-0001
 * records why, and ADR-0002 the correction and the spike that may reverse it.
 */

export const JSONRPC_VERSION = '2.0'
export const LATEST_PROTOCOL_VERSION = '2026-07-28'
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION] as const

// Standard JSON-RPC
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

// Reserved by MCP 2026-07-28
export const HEADER_MISMATCH = -32020
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

export type RequestId = string | number

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  result: Record<string, unknown>
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId | null
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse

/** `_meta` keys this revision defines. In a stateless protocol this replaces the session. */
export const MetaKeys = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  logLevel: 'io.modelcontextprotocol/logLevel',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  progressToken: 'progressToken',
} as const

export function success(id: RequestId, result: Record<string, unknown>): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

export function failure(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }
}
