# Launch kit

All numbers below are measured (see [benchmark.md](benchmark.md)): six popular MCP servers = **111 tools, 28,307 tokens per request → 719 with slimcp (−97%)**. The demo setup (Claude Desktop, five servers) = **27,232 tokens, 14% of a 200K window, grade D → ≈652 (−98%)**. Search: top-1 68%, top-3 85%, top-5 93% on 40 queries. Don't round these up.

Links: repo https://github.com/alperensarikavak/slimcp · npm https://www.npmjs.com/package/slimcp

---

## Show HN

**Title** (≤ 80 chars):

> Show HN: Slimcp – cut MCP tool definitions from 28k tokens to 719 per request

**Text:**

> MCP clients send every tool's name, description and JSON schema to the model on every request. With six popular servers (GitHub, Notion, Playwright, filesystem, memory, everything) that is 111 tools and 28,307 tokens before you type anything — Notion's server alone is ~17k.
>
> slimcp is two things:
>
> 1. `npx slimcp audit` — finds the MCP configs of Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI and Codex on your machine, starts each server once, and tells you per client how many tokens you pay per request, as a share of the window and an A–F grade. It also tells you when Claude Code's built-in tool search has been silently turned off (e.g. by an ANTHROPIC_BASE_URL gateway).
>
> 2. A stdio MCP proxy. Your client sees your most-used tools (auto-pinned from local stats) plus `find_tools` and `call_tool`. The hidden tools are found with a small BM25 index — no embeddings, no network. Same six servers: 719 tokens (−97%). Catalogs are cached so startup doesn't spawn anything; huge tool outputs are capped; destructive tools only run when pinned so your client still asks for approval.
>
> Honest caveats: Claude Code and Cursor already defer tools natively, so this mostly helps clients that don't (Claude Desktop, Gemini CLI, Windsurf, VS Code, Codex), local models and custom agents. Search adds a step and isn't perfect (68% top-1 / 93% top-5 on my 40-query benchmark — the misses are in the repo). There are similar proxies (lazy-mcp, mcp-lazy-proxy); the audit, one-command init/restore and the safety gate are what I wanted on top.
>
> No telemetry, no network calls of its own, MIT. `npx slimcp audit` is read-only — I'd love to see what grades people get.

---

## Reddit

### r/ClaudeAI

**Title:** My Claude Desktop MCP servers were eating 27k tokens (14% of the window) on every message — I built a free tool to audit and fix it

> If you use Claude Desktop with a few MCP servers: every tool definition is sent with every message. My five servers (Notion, Playwright, GitHub, filesystem, memory) cost **27,232 tokens per request — grade D**.
>
> `npx slimcp audit` shows this per client and per server (read-only, nothing to install). `npx slimcp init --yes` then puts a small proxy in front: Claude sees a few pinned tools plus a search tool, and the same setup drops to ~650 tokens. Backups are made and `npx slimcp restore` undoes it.
>
> Claude Code users: you probably don't need the proxy — its tool search already defers MCP tools — but the audit will tell you if it's been turned off (e.g. by a custom ANTHROPIC_BASE_URL).
>
> Open source (MIT), no telemetry: https://github.com/alperensarikavak/slimcp — post your grade!

### r/LocalLLaMA

**Title:** MCP tool schemas can eat 28k tokens of your context — a local, no-network proxy that cuts it to ~700

> With local models the context window is precious: 111 tools from six common MCP servers = 28,307 tokens of tool definitions per request (o200k count; your tokenizer will differ, the ratio holds).
>
> slimcp is a stdio MCP proxy that exposes your most-used tools plus `find_tools`/`call_tool`, with a plain BM25 search over the rest — no embeddings model, no API, nothing leaves your machine. 719 tokens for the same 111 tools. It also caps giant tool outputs (default 12k tokens) so one `read_file` doesn't blow the window.
>
> `npx slimcp audit --window 32k` grades your setup against a smaller window. Works with any MCP client or as a library in your own agent. Benchmark + search accuracy (68% top-1, 93% top-5) are in the repo: https://github.com/alperensarikavak/slimcp

### r/mcp

**Title:** slimcp: audit how many tokens your MCP servers cost per client, and a lazy-loading proxy with a destructive-tool gate

> Built this after measuring my own setup. Features:
> - `audit`: per-client report (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, Codex), tokens per server, heaviest tools, grade A–F, `--markdown` with badges. Flags Claude Code tool search being off.
> - proxy: pinned tools + `find_tools` (BM25, lists every hidden tool name) + `call_tool`; lazy start from a catalog cache; schema minification that never touches parameter names; output caps; no orphaned child processes.
> - safety: tools with `destructiveHint: true` are refused through `call_tool` until pinned, so the client's per-tool approval still applies.
> - `init --yes` / `restore` with backups; configs with secrets are 0600.
>
> Numbers: 28,307 → 719 tokens for GitHub+Notion+Playwright+filesystem+memory+everything. Feedback on the search and on server annotations very welcome: https://github.com/alperensarikavak/slimcp

---

## X / LinkedIn thread

Attach a screenshot of the audit (the grade line visible) — e.g. crop `assets/demo.svg` or your own run.

1. Your MCP servers eat your AI's context window before you type a word.
   My Claude Desktop: 98 tools, 27,232 tokens, 14% of the window — on every message. Grade D. 🧵
2. Why: MCP clients send every tool's name + description + JSON schema with every request. Notion's server alone is ~17k tokens.
3. So I built slimcp. Check yours in 30 seconds, read-only:
   `npx slimcp audit`
4. Fix it: `npx slimcp init --yes`. Your client sees your most-used tools + a search tool. Six popular servers go from 28,307 → 719 tokens (−97%). `npx slimcp restore` undoes it.
5. Search is local BM25 — no embeddings, no network, no telemetry. 93% of my 40 test queries hit in the top 5; your daily tools are auto-pinned so they skip search entirely.
6. Safety: destructive tools only run when pinned, so your client still asks before each call. Backups + 0600 secret files.
7. Claude Code / Cursor already defer tools natively — the audit tells you if that got switched off.
   MIT, open source: https://github.com/alperensarikavak/slimcp
   What grade did you get? Paste your share line 👇

Share line format the audit prints:
> My MCP servers eat 27,232 tokens (14% of the context window) before I type a word — grade D. Check yours: npx slimcp audit

---

## Awesome-list PRs

Read each list's CONTRIBUTING first (format, alphabetical order, category, emoji legend) and match it exactly.

### punkpeye/awesome-mcp-servers

Section: aggregators / developer tools (whichever covers proxies).

> - [alperensarikavak/slimcp](https://github.com/alperensarikavak/slimcp) 📇 🏠 🍎 🪟 🐧 - MCP proxy that cuts tool-definition tokens by 90%+ (pinned tools + local BM25 `find_tools`/`call_tool`), with a per-client context audit for Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI and Codex.

PR title: `Add slimcp (MCP proxy that cuts tool-definition tokens)`
PR body: "slimcp is an MIT stdio MCP proxy that exposes pinned tools plus a search/call pair, cutting six popular servers from 28,307 to 719 tokens per request (benchmark in repo). It also audits MCP context usage per client. TypeScript, local only, no telemetry."

### hesreallyhim/awesome-claude-code

Section: tooling / MCP.

> - [slimcp](https://github.com/alperensarikavak/slimcp) by [alperensarikavak](https://github.com/alperensarikavak) — audits how many tokens your MCP servers cost in Claude Code and Claude Desktop (and warns when Claude Code's tool search is off), plus a lazy-loading MCP proxy for clients and gateways without tool search.

(This list may require submitting through its issue form rather than a PR — check its README.)

### appcypher/awesome-mcp-servers

Section: developer tools.

> - **[slimcp](https://github.com/alperensarikavak/slimcp)** - Proxy that hides most MCP tools behind local search to save 90%+ of tool-definition tokens, plus a context audit for every major MCP client.

---

## Launch-day checklist

- [ ] Release `v0.1.0` is on npm with provenance; `npx slimcp@0.1.0 audit` works on a clean machine (macOS, Windows, Linux).
- [ ] Social preview uploaded (Settings → Social preview → `assets/social-preview.png`), repo pinned on your profile, topics set.
- [ ] README renders on GitHub *and* npm (demo SVG, Mermaid, badges green).
- [ ] Post **Tuesday–Thursday around 8am PT** (Show HN first, Reddit ~1–2 h later, X/LinkedIn the same morning). One subreddit per day is better than all at once.
- [ ] **Answer every comment within an hour** for the whole first day — be specific, admit limits, thank people for bug reports and turn them into issues quickly.
- [ ] Ship small fixes the same day and mention them in the threads ("fixed in 0.1.1, thanks!").
- [ ] The **first 48 hours decide GitHub Trending** — star velocity matters more than totals; don't ask for stars beyond the README line, ask for grades/feedback.
- [ ] Open the awesome-list PRs on day 2–3, once there is some traction to point to.
- [ ] After a week: write up what people's audits showed (aggregate, no personal data) as a follow-up post.
