# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-27

### Added
- `slimcp_status` meta-tool (read-only): configured servers with state (connected, cached, failed with the
  error, disabled), tool counts and the estimated tokens saved per request.
- `Dockerfile`: runs `slimcp serve` with an empty config and needs no network at runtime.
- `glama.json` so the maintainer can claim the Glama listing.

### Changed
- `find_tools`, `call_tool` and `slimcp_status` are now always exposed, even with no upstream servers or when
  every tool is pinned.
- Tighter, clearer meta-tool descriptions (when to use them, side effects, output cap) and MCP annotations:
  `find_tools` / `slimcp_status` are `readOnlyHint: true, openWorldHint: false`; `call_tool` is
  `readOnlyHint: false, openWorldHint: true`.
- The three meta-tools cost a fixed ~300 tokens; the six-server benchmark is 28,307 → 801 tokens (−97%),
  previously 719 with two meta-tools.

## [0.1.0] - 2026-11-26

First release.

### Added
- `slimcp audit`: per-client report of MCP tool tokens (o200k), share of a 200K window and an A–F grade,
  for Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI and Codex CLI.
  Detects when Claude Code's tool search is off. `--cached`, `--markdown`, `--json`, `--window`, `--client`.
- `slimcp init` (dry run by default, `--yes` to apply) with backups, and `slimcp restore`.
- `slimcp serve`: stdio MCP proxy exposing pinned tools plus `find_tools` / `call_tool`, lazy start from a
  catalog cache, BM25 tool search, schema minification, output caps and clean shutdown of child servers.
- Auto-pinning of the most-used tools from local usage stats; `slimcp stats`.
- Destructive-tool gate: tools annotated `destructiveHint: true` only run when pinned.
- `slimcp wrap -- <command>` to proxy a single server without a config file.
- Library API (`SlimProxy`, `runAudit`, `buildExposure`, …).
- Benchmark against six real MCP servers (`npm run bench`): 28,307 → 719 tokens (−97%).

[0.1.1]: https://github.com/alperensarikavak/slimcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/alperensarikavak/slimcp/releases/tag/v0.1.0
