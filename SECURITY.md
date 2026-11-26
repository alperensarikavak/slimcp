# Security Policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub Security Advisories](https://github.com/alperensarikavak/slimcp/security/advisories/new)
("Report a vulnerability" on the Security tab). You will get a response within a few days, and a fix and
advisory as soon as practical. Only the latest released version receives security fixes.

## What slimcp stores, and where

Everything lives in `~/.slimcp` (or `$SLIMCP_HOME`), created with mode `0700`:

| file | contents | mode |
|---|---|---|
| `<client>-<scope>[-hash].json` | Server configs moved there by `init`, **including any env vars / headers (tokens)** they had | `0600` |
| `cache/<hash>.json` | Tool catalogs (names, descriptions, schemas) — no secrets | `0600` |
| `usage.json` | Call counts and last-used time per tool id — no arguments or results | `0600` |
| `backups.json` | Paths of backups made by `init` | `0600` |

`init` also writes `<your config file>.slimcp-backup-<timestamp>` next to each file it changes (mode `0600`),
since those files may contain tokens. On Windows, POSIX modes do not apply; the files inherit your user
profile's ACLs.

## Network

slimcp makes **no network requests of its own**: no telemetry, no analytics, no update checks, no embeddings
API. Tool search runs locally. The only connections it makes are to the MCP servers you configured
(spawning stdio servers, or connecting to the HTTP/SSE URLs in your config).

## Logging

slimcp never logs tool-call arguments or results. Its stderr shows server names, tool counts and error
messages (including the last lines of a failing server's own stderr).

## The per-tool approval trade-off and the destructive-tool gate

MCP clients ask for approval per tool name. Behind slimcp, hidden tools run through the `call_tool`
meta-tool, so approving `call_tool` once (or auto-approving it) would cover every hidden tool. To limit this:

- `call_tool` never carries `readOnlyHint` or other auto-approve hints. Only `find_tools` (which only
  searches) is marked read-only.
- **Destructive-tool gate:** a tool annotated `destructiveHint: true` (and not `readOnlyHint: true`) is
  refused by `call_tool` and returns instructions to pin it. Pinned tools appear under their own name, so the
  client shows its normal per-tool approval prompt. Set `allowDestructiveViaCallTool: true` to opt out.
- The gate relies on servers annotating their tools. Pin any tool you want approved individually.

## Supply chain

Releases are published to npm only from GitHub Actions with
[provenance](https://docs.npmjs.com/generating-provenance-statements) via trusted publishing. `init` writes
an exact version (`slimcp@x.y.z`) into client configs, never `@latest`.
