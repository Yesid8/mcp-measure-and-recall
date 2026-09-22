#!/usr/bin/env node
import { build } from './server.js'
import { loadConfig } from './config.js'
import { captureConsole, ndjsonLog, serveStdio } from './transport/stdio.js'

/** How long calls in flight get to finish once shutdown starts. */
const SHUTDOWN_GRACE_MS = 5_000

const restore = captureConsole(process.stderr)
const log = ndjsonLog(process.stderr)

/**
 * Refuses to start, with a message a human will read: the one who sees it is
 * looking at a client that will not connect, not at a log.
 */
function refuse(message: string, detail: unknown): never {
  log('error', message, detail)
  process.stderr.write(`\nfacts-mcp: ${message}\n`)
  restore()
  process.exit(1)
}

// A configuration that does not parse stops the server rather than falling
// back to a default: a mistyped allowlist must not quietly become loopback.
const config = loadConfig()
if (!config.ok) refuse(config.error.message, config.error.detail)

const { server, lock, close } = build({
  policy: config.value.policy,
  defaultStaleSeconds: config.value.defaultStaleSeconds,
})

// Take the instance lock before serving a single request. Two servers over one
// data directory can interleave writes and split a line of the registry, and a
// corrupt registry is worse than a server that refuses to start.
const acquired = await lock()
if (!acquired.ok) refuse(acquired.error.message, acquired.error.detail)

let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  // Answer or abort what is in flight before the logs close under it.
  void server
    .drain(SHUTDOWN_GRACE_MS)
    .then(close)
    .finally(() => {
      restore()
      process.exit(0)
    })
}

serveStdio(server, { onClose: shutdown })
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
