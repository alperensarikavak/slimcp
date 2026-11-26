# Contributing to slimcp

Thanks for helping! Bug reports, client support, benchmark queries and docs fixes are all welcome.

## Dev setup

Node 18.17 or newer.

```bash
git clone https://github.com/alperensarikavak/slimcp && cd slimcp
npm install
npm run typecheck
npm test            # unit + e2e (spawns test/fixtures/server.mjs, a fake 42-tool MCP server)
npm run build
npm run dev -- audit --cached     # run the CLI from source
```

`npm run bench` installs six real MCP servers into `.bench/` (gitignored) and rewrites `docs/benchmark.md`.
It only lists tools; no API keys are needed.

Project layout: everything lives in `src/` — `discover.ts` (client registry), `normalize.ts` (config formats),
`search.ts` (BM25), `expose.ts` (pinning + meta-tools), `proxy.ts` (the MCP server), `audit.ts` / `report.ts`,
`init.ts`, `cli.ts`.

## Adding an MCP client

Add one entry to `CLIENTS` in [`src/discover.ts`](src/discover.ts):

```ts
{
  id: "my-client",                    // used by --client
  name: "My Client",                  // shown in reports
  locations: (ctx) => [
    // ctx.home / ctx.cwd / ctx.platform / ctx.env are injectable for tests
    { path: join(ctx.home, ".my-client", "mcp.json"), keyPath: ["mcpServers"], scope: "user", format: "json" },
  ],
  // Optional: return a note if the client already defers MCP tools on its own.
  nativeDeferral: (env) => undefined,
},
```

- `format` is `json`, `jsonc` or `toml` (TOML is audit-only; `init` prints a snippet).
- If the client uses an unusual server shape (a new URL key, a header key, …), teach `normalizeServer` in
  [`src/normalize.ts`](src/normalize.ts) and add a case to `test/normalize.test.ts`.
- Add the client to the discovery e2e test in `test/e2e.test.ts` and to the README lists.
- If `init` needs a special entry shape (like VS Code's `type: "stdio"`), update `slimcpEntry` in `src/init.ts`.

## Adding benchmark queries

Append `[query, expectedToolId]` to `QUERIES` in [`scripts/benchmark.mjs`](scripts/benchmark.mjs).
Write them the way a person would actually ask. Please do **not** tune the synonym table in `src/search.ts`
just to make a benchmark query pass — if you improve search, show that it helps across the board.

## Pull requests

- Keep PRs focused; add or update tests.
- `npm run typecheck && npm test` must pass (CI runs Node 18/20/22 on Linux, macOS and Windows).
- Never add network calls, telemetry or logging of tool arguments/results. See [SECURITY.md](SECURITY.md).
- Add a line to `CHANGELOG.md` under an "Unreleased" heading.
