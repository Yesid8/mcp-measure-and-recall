# Contributing

## Setup

```bash
npm ci
npm run build
npm test
```

Node 22.11 or newer. The TLS tests need `openssl` on the path and skip without it.

Run one file or one test while working:

```bash
npx vitest run test/contract/recall.test.ts
npx vitest run -t "http_status 500"
```

Contract tests drive the real server over real streams through
[`test/fixtures/client.ts`](test/fixtures/client.ts); prefer them to calling internals, since
framing and error mapping are where protocol bugs live.

## The invariants

A change that breaks one of these is not accepted, however useful it looks. Each is
enforced by a test.

1. **No output field is a judgement.** No `health`, `score`, `passed`, `summary`. `ok` means
   only that the observation could be taken; a cleanly received HTTP 500 is `ok: true`.
2. **Every response carries its time**, and every item in a collection carries its own age.
3. **`recall.*` never measures.** It returns `remeasure_with` instead.
4. **Nothing is deleted.** The logs are append-only; a retraction is a new event.
5. **Nothing in `src/` knows a particular application.** No host, port, route or product
   name, in code, tests or defaults.
6. **Redaction happens before anything is written.** Never after.
7. **No path fails open.** When a limit is reached, return less, marked with a warning —
   never more than was verified.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage
```

CI runs the same on Linux and Windows. Describe what changed and why; if the change touches
the protocol, cite the part of the MCP `2026-07-28` schema in `vendor/` it follows. Design
decisions are recorded as ADRs in [docs/adr/](docs/adr/): a change that reverses one needs a
new ADR saying why.

Code, identifiers and comments are in English; the specification in `docs/` is in Spanish.
Comments explain what the code cannot say by itself — a constraint, a trade-off, a bug it
prevents — not what the next line does.
