# Security

## Supported versions

Only the latest release receives fixes while the project is below 1.0.

## Reporting a vulnerability

Please report it privately through GitHub's **Report a vulnerability** button on this
repository's Security tab, not in a public issue. Include the version or commit, the
configuration (`PLINTH_FACTS_NET_PROFILE` and friends, never real credentials), and the
smallest sequence of tool calls that shows the problem. Expect a first answer within 72
hours.

## What the server defends against

It performs network requests on behalf of a model, and it stores what it sees. These are
the risks it is built around; a way past any of them is a vulnerability.

| Risk | Defence |
|---|---|
| Server-side request forgery, DNS rebinding | The policy judges every **resolved address**, not the name; the connection goes to the address that passed, and every redirect hop is checked again. Link-local addresses — cloud metadata at `169.254.169.254` — are refused under every profile |
| Widening the network reach from a tool call | The profile is fixed by the operator at startup. No argument can change it; the allowlist takes exact `host:port` pairs, never wildcards |
| Credentials leaking into storage or logs | Redaction runs before anything is written, returned or logged: headers, cookies, URL userinfo, secret query parameters, known token shapes. Credentials never cross a redirect to another origin |
| Writing outside the data directory | Project names are normalized to a safe slug; every path is resolved with `realpath` and must stay under the data root; a symlink in place of a log is refused |
| Two processes corrupting one registry | An instance lock per data directory |
| Resource exhaustion | Caps on body size, decompression ratio (100:1), WebSocket message and total bytes, line length on stdin, and a deadline on every call |

## What it does not defend against

**Prompt injection is an accepted risk.** The server returns what a service sent — that is
its purpose — and a response body can contain text addressed to the model reading it. The
server never follows instructions in what it measures, and it never interprets it; what the
consuming model does with the text is outside what this server can control.
