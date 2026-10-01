# facts-mcp

An MCP server that only holds facts. It measures and it remembers; it never judges.

Point it at a service — a local app, a device on your network, a public API or website — and
it returns the raw measurement with the time it was taken. Write down what you concluded,
with the evidence, and it keeps that claim — for good. Nothing in it is a verdict, so an
agent reading it does not have to verify the answer.

It knows nothing about any particular application. The project is a parameter of every
call, and what the server may reach is set by whoever runs it, not by the code.

## The three rules

Without these, this is just another agent you would have to check.

1. **If something can be measured now, it is not answered from memory.** `recall.*` never
   measures. When it returns a claim backed by a measurement it also returns
   `remeasure_with` — the exact tool and arguments to take that measurement again yourself.
2. **Every response carries the time it was observed**, so staleness is visible. Each item in
   a collection carries *its own* age, not the age of the query.
3. **No output field is a judgement.** No `health`, `score`, `severity`, `passed`,
   `recommendation`. `ok` means only *"the observation could be taken"*.

And the distinction that holds it together: **an error of observation is not the observation
of an error.** A cleanly received HTTP 500 is a success of the tool — `ok: true`,
`http_status: 500`. Only what *prevented* measuring is an error.

## Install and run

Requires Node 22.11 or newer. The package is not on npm yet; build it from a clone:

```bash
git clone https://github.com/Yesid8/mcp-measure-and-recall.git
cd mcp-measure-and-recall
npm ci
npm run build
```

It speaks MCP over stdio. Point any MCP client at the built entry point, with a data
directory of its own:

```jsonc
{
  "mcpServers": {
    "facts": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-measure-and-recall/dist/main.js"],
      "env": { "PLINTH_DATA_DIR": "/absolute/path/to/a/data/dir" }
    }
  }
}
```

On Windows, write the paths with forward slashes or doubled backslashes: a single
backslash in JSON is an escape. If the client does not connect, read its stderr — every
refusal to start begins with `facts-mcp:` and says why. The guide for consumers is
[docs/USO.md](docs/USO.md).

## The six tools

Every call takes `project`, a free string that isolates one consumer's data from another's.
It is created on first use and returned normalized, so a typo is visible immediately.

| Tool | What it returns |
|---|---|
| `facts.measure.http` | Status, headers, body, timings — and which IP it actually connected to |
| `facts.measure.ws` | The messages that arrived in N seconds, each with absolute time and offset |
| `facts.recall.assert` | The claim as written, with its evidence embedded |
| `facts.recall.retract` | The claim marked retracted, with a reason. Never deleted |
| `facts.recall.query` | Claims with their age, their `stale` mark, and how to measure them again |
| `facts.recall.history` | The raw events of one claim, in order |

### A worked example

Measure an endpoint:

```jsonc
// facts.measure.http
{ "project": "checkout", "url": "http://localhost:3000/api/orders" }
```

```jsonc
{
  "observation_id": "o_01K5Z9K2QX7T4BVWRM3P8QJHYD",
  "observed_at": "2026-09-22T10:14:03.482+02:00",
  "age_seconds": 0.14,
  "age_basis": "monotonic",
  "ok": true,
  "error": null,
  "data": {
    "kind": "http",
    "http_status": 200,
    "body": { "orders": [] },
    "peer": { "address": "127.0.0.1", "port": 3000, "family": 4 }
  }
}
```

Write down what you concluded, citing that measurement:

```jsonc
// facts.recall.assert
{
  "project": "checkout",
  "statement": "GET /api/orders responds 200 with an empty array",
  "evidence": [{ "type": "observation", "observation_id": "o_01K5Z9K2QX7T4BVWRM3P8QJHYD" }],
  "observed_by": "claude-opus-5 (session 3f9a1c7e)",
  "tags": ["api", "orders"]
}
```

Three days later, someone reads the registry:

```jsonc
// facts.recall.query → { "project": "checkout", "text": "orders" }
{
  "claim_id": "c_01K5Z9M5P0RA2CF7XN4T6WQJBE",
  "statement": "GET /api/orders responds 200 with an empty array",
  "age_seconds": 259200.0,
  "stale": true,
  "remeasure_with": {
    "tool": "facts.measure.http",
    "arguments": { "project": "checkout", "url": "http://localhost:3000/api/orders" },
    "omitted": []
  }
}
```

The server does not decide whether to re-measure. It gives you the age and the how; the
decision is yours. If the answer has changed, retract with a reason — the original claim
stays in the log, byte for byte, and `facts.recall.history` shows both events.

## Where the data lives

```
$PLINTH_DATA_DIR/                 # defaults to ~/.plinth
└── projects/<project>/logs/
    ├── claims.jsonl              # append-only. Readable with tail, copyable with rsync
    └── observations.jsonl        # measurements, failed ones included, so they can be cited
```

`claims.jsonl` is append-only in the strict sense: a retraction is a new line, never an edit.
The current state is a projection over the events. There is no `update` and no `delete` — not
discouraged, absent from the interface.

## Network safety

Measurements come from **the server's network position**, and the destination is validated by
resolved IP, not by name. A name is not a destination: `evil.localhost` can resolve to a
public address, and can resolve to loopback once and to something else a moment later.

- Every resolved address is classified; if **any** falls outside the profile, the call is
  refused without opening a socket.
- The connection is made to the **validated address**, with the original `Host` and SNI, which
  closes the window between checking and connecting.
- Every redirect hop repeats the whole check.
- `169.254.169.254` and all link-local addresses are denied in **every** profile, allowlist
  included. That is the first stop of any exfiltration in a container.
- Environment proxies are ignored: a proxy would bypass the IP validation entirely.

The operator picks one profile when starting the server; no tool argument can widen it:

| Profile | Reaches |
|---|---|
| `deny-all` | Nothing |
| `loopback` (default) | Services on the same machine |
| `private` | The same machine and private networks (RFC 1918, `fc00::/7`) — devices on your LAN |
| `allowlist` | Exactly the `host:port` pairs listed, public or not — the way to measure a website |

An allowlist entry is an exact `host:port`. There are no domain wildcards, because a
wildcard turns an MCP server into an outbound proxy with an extra step; a malformed entry
stops the server at startup rather than being ignored. The active profile is stated in
`server/discover`, so the model knows where it can measure from.

Secrets (`authorization`, `cookie`, `set-cookie`, API keys, JWTs, PEM blocks, URL userinfo,
query parameters such as `?token=`) are sent intact to the destination and redacted
**before** anything is written to disk, returned, or logged — claims and retraction reasons
included. There is no window in which a credential sits in a file. `remeasure_with` leaves
out whatever was redacted rather than replaying a placeholder as a broken request, and names
it in `omitted` so you know what to supply.

## Configuration

Read once at startup. A value that does not parse stops the server with a message naming
the variable.

| Variable | Default | Effect |
|---|---|---|
| `PLINTH_DATA_DIR` | `~/.plinth` | Where the registry lives. Give each client its own: one server per directory |
| `PLINTH_FACTS_NET_PROFILE` | `loopback` | `deny-all`, `loopback`, `private` or `allowlist` |
| `PLINTH_FACTS_ALLOW_HOSTS` | — | Comma-separated `host:port` pairs. Required by `allowlist`, refused by the others |
| `PLINTH_FACTS_MAX_REDIRECTS` | `5` | Hops a call may follow when it asks to (`0`–`20`) |
| `PLINTH_FACTS_DEFAULT_STALE_SECONDS` | `3600` | `stale` threshold when a query gives none |

To measure a public site, for example:

```jsonc
"env": {
  "PLINTH_DATA_DIR": "/absolute/path/to/a/data/dir",
  "PLINTH_FACTS_NET_PROFILE": "allowlist",
  "PLINTH_FACTS_ALLOW_HOSTS": "api.example.com:443,www.example.com:443"
}
```

No variable introduces knowledge of any particular project: no base URLs, no routes, no
credentials. That is the point — the same server serves every app you point it at.

## What it will never do

`measure.assert_status` · `measure.wait_until` · `recall.summarize` · `recall.rank` ·
`recall.delete` · `project.health`

Each one breaks rule 1 or rule 3. The moment this server starts giving verdicts it stops
being a source and becomes another agent you have to verify — which is exactly the work it
exists to save.

## Protocol

Speaks both eras of MCP, chosen per connection by the client's first message:

- **`2025-06-18` and `2025-11-25`**, opened with `initialize` — what Claude Code and most
  clients use today.
- **`2026-07-28`**, the stateless revision: `server/discover`, a `_meta` envelope on every
  request, `resultType` on every result.

Nothing to configure. See [ADR-0004](docs/adr/0004-hablar-tambien-la-era-de-sesion.md).

The wire format is implemented directly against the normative schema, which is vendored in
`vendor/` and checked against the implementation at compile time. The official SDK for this
revision exists as `@modelcontextprotocol/server` 2.0; whether to adopt it is a measured
decision still to be taken, and every protocol detail lives behind `src/protocol/` so that
swapping it touches nothing else. See [ADR-0001](docs/adr/0001-implementar-protocolo-sin-sdk.md)
and [ADR-0002](docs/adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md).

## Building your own server on the core

The package exports the core facts-mcp is built from — `ProtocolServer`, `serveStdio`,
`defineTool`, `Result`, the envelope, redaction — for an MCP server with tools of its own.
Install it from a release tag; it builds itself on install:

```bash
npm install github:Yesid8/mcp-measure-and-recall#v0.2.1
```

Use `ProtocolServer` directly, not `build()`: `build()` is facts-mcp, including a store that
writes every observation to disk. `ProtocolServer` writes nothing unless given a
`recordObservation`. Its `toolPrefix` option replaces the `facts.` prefix (`''` for bare
names) and `requireProject: false` drops the `project` parameter. Example and details in
[docs/USO.md](docs/USO.md#construir-un-servidor-propio-sobre-el-núcleo).

## Development

```bash
npm install
npm run typecheck      # strict, with noUncheckedIndexedAccess and exactOptionalPropertyTypes
npm test               # unit, contract and conformance tests
npm run test:coverage  # the same, with a coverage floor that fails the run
npm run lint
npm run format:check
npm run build
```

CI runs all of the above on Linux and Windows, on Node 22 and 24. Windows is in the matrix
on purpose: file truncation and stdin chunking behave differently there, and two of the bugs
the tests now guard against only ever showed up on it.

The TLS tests generate a throwaway certificate with `openssl` and skip when it is not
installed; no key material is committed.

The tests are the contract, not examples. They fail if the server starts judging: a 500 must
stay `ok: true`, silence on a socket must stay a valid observation, a retraction must leave
the previous bytes untouched, and a clock jumping backwards must never produce a negative age.
The mechanical checks of the specification run as ordinary tests too: every schema field
described, no judgement key in any output, no secret in any file on disk, no socket opened
under `deny-all`, no host:port or API route anywhere in `src/`.

Specification in [docs/](docs/). Prose is in Spanish; code, field names and error codes are
in English. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).

## License

[0BSD](LICENSE): use, copy, modify and distribute it for any purpose, with or without fee,
and with no attribution required.
