#!/usr/bin/env node
// Benchmark: token cost of six popular MCP servers, with and without slimcp,
// plus find_tools search quality on 40 natural-language queries.
//
//   npm run bench            (installs the servers into .bench/ on first run)
//
// Only tools/list is called. No API keys are needed: GitHub gets a dummy token.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = join(ROOT, ".bench");
// Keep the benchmark's catalog cache and usage stats out of ~/.slimcp, so auto-pinning can't skew results.
process.env.SLIMCP_HOME = join(BENCH, "state");

const SERVERS = [
  { name: "github", pkg: "@modelcontextprotocol/server-github", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "dummy-token-for-listing-only" } },
  { name: "notion", pkg: "@notionhq/notion-mcp-server" },
  { name: "playwright", pkg: "@playwright/mcp" },
  { name: "filesystem", pkg: "@modelcontextprotocol/server-filesystem", args: [join(BENCH, "sandbox")] },
  { name: "memory", pkg: "@modelcontextprotocol/server-memory", env: { MEMORY_FILE_PATH: join(BENCH, "sandbox", "memory.json") } },
  { name: "everything", pkg: "@modelcontextprotocol/server-everything" },
];

// Natural-language requests → the tool a person would expect. Written as users phrase things,
// not tuned to the synonym table.
const QUERIES = [
  ["open a pull request from my feature branch", "github__create_pull_request"],
  ["file a bug report in the repo", "github__create_issue"],
  ["comment on an issue", "github__add_issue_comment"],
  ["merge the PR", "github__merge_pull_request"],
  ["find repositories about machine learning", "github__search_repositories"],
  ["fork someone's repository", "github__fork_repository"],
  ["show recent commits on main", "github__list_commits"],
  ["which files changed in this pull request", "github__get_pull_request_files"],
  ["close an issue", "github__update_issue"],
  ["create a new branch", "github__create_branch"],
  ["search code for a function name", "github__search_code"],
  ["approve a pull request with a review", "github__create_pull_request_review"],
  ["search my Notion workspace for meeting notes", "notion__API-post-search"],
  ["create a new page in Notion", "notion__API-post-page"],
  ["add a comment to a Notion page", "notion__API-create-a-comment"],
  ["query a Notion database with filters", "notion__API-query-data-source"],
  ["append blocks to a page", "notion__API-patch-block-children"],
  ["get the markdown content of a Notion page", "notion__API-retrieve-page-markdown"],
  ["list all users in the workspace", "notion__API-get-users"],
  ["delete a block", "notion__API-delete-a-block"],
  ["go to https://example.com", "playwright__browser_navigate"],
  ["take a screenshot of the page", "playwright__browser_take_screenshot"],
  ["click the login button", "playwright__browser_click"],
  ["type text into the search box", "playwright__browser_type"],
  ["fill out the signup form", "playwright__browser_fill_form"],
  ["go back to the previous page", "playwright__browser_navigate_back"],
  ["read the browser console errors", "playwright__browser_console_messages"],
  ["upload a file in the browser", "playwright__browser_file_upload"],
  ["press the Enter key", "playwright__browser_press_key"],
  ["close the browser", "playwright__browser_close"],
  ["read a text file", "filesystem__read_text_file"],
  ["list the files in a folder", "filesystem__list_directory"],
  ["rename a file", "filesystem__move_file"],
  ["make a new folder", "filesystem__create_directory"],
  ["show the directory tree", "filesystem__directory_tree"],
  ["find files matching *.ts", "filesystem__search_files"],
  ["add a new person to the knowledge graph", "memory__create_entities"],
  ["look up what you know about Alice in memory", "memory__search_nodes"],
  ["forget an entity from memory", "memory__delete_entities"],
  ["add two numbers", "everything__get-sum"],
];

function ensureInstalled() {
  mkdirSync(join(BENCH, "sandbox"), { recursive: true });
  if (!existsSync(join(BENCH, "package.json"))) writeFileSync(join(BENCH, "package.json"), '{ "name": "slimcp-bench", "private": true }\n');
  const missing = SERVERS.filter((s) => !existsSync(join(BENCH, "node_modules", s.pkg, "package.json")));
  if (!missing.length) return;
  console.error(`Installing ${missing.map((s) => s.pkg).join(", ")} into .bench/ …`);
  execSync(`npm install --no-audit --no-fund ${missing.map((s) => s.pkg).join(" ")}`, { cwd: BENCH, stdio: "inherit" });
}

function binOf(pkg) {
  const dir = join(BENCH, "node_modules", pkg);
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const bin = typeof json.bin === "string" ? json.bin : Object.values(json.bin)[0];
  return { path: join(dir, bin), version: json.version };
}

const fmt = (n) => n.toLocaleString("en-US");
const pct = (a, b) => `−${Math.round((1 - b / a) * 100)}%`;

async function main() {
  ensureInstalled();
  const lib = await import(pathToFileURL(join(ROOT, "dist", "index.js")).href);
  const { connect, listAllTools, toolTokens, buildExposure, DEFAULT_OPTIONS } = lib;
  const exposedTokens = (catalogs) => buildExposure(catalogs, DEFAULT_OPTIONS, []).tools.reduce((a, t) => a + toolTokens(t), 0);

  const catalogs = {};
  const rows = [];
  for (const s of SERVERS) {
    const { path, version } = binOf(s.pkg);
    const spec = { name: s.name, transport: "stdio", command: process.execPath, args: [path, ...(s.args ?? [])], env: s.env };
    const conn = await connect(spec, { timeoutMs: 90_000 });
    try {
      const tools = await listAllTools(conn.client);
      catalogs[s.name] = tools;
      const normal = tools.reduce((a, t) => a + toolTokens(t), 0);
      rows.push({ name: s.name, pkg: `${s.pkg}@${version}`, tools: tools.length, normal, slim: exposedTokens({ [s.name]: tools }) });
    } finally {
      await conn.close();
    }
  }
  const totalTools = rows.reduce((a, r) => a + r.tools, 0);
  const totalNormal = rows.reduce((a, r) => a + r.normal, 0);
  const totalSlim = exposedTokens(catalogs);

  const out = [];
  out.push("# slimcp benchmark", "");
  out.push(
    `Measured ${new Date().toISOString().slice(0, 10)} with Node ${process.version} on ${process.platform}. ` +
      "Tokens are counted with the o200k_base tokenizer over `{name, description, input_schema}` of each tool, " +
      "which is what a client sends to the model on every request. Counts are approximate (each model tokenizes " +
      "differently and each client adds its own framing); the relative saving is what matters.",
    "",
    "slimcp settings: defaults (`pin: [\"auto\"]` with no usage history yet, `minify: \"safe\"`, `catalog: \"names\"`). " +
      "So the slimcp column is the three meta-tools `find_tools` + `call_tool` + `slimcp_status` (a fixed ~300 tokens), where `find_tools` lists every hidden tool name.",
    "",
  );
  out.push("## Tokens per request", "");
  out.push("| server | tools | normal tokens | slimcp tokens | saved |", "|---|---:|---:|---:|---:|");
  for (const r of rows) out.push(`| ${r.name} | ${r.tools} | ${fmt(r.normal)} | ${fmt(r.slim)} | ${pct(r.normal, r.slim)} |`);
  out.push(`| **All together** | **${totalTools}** | **${fmt(totalNormal)}** | **${fmt(totalSlim)}** | **${pct(totalNormal, totalSlim)}** |`, "");
  out.push("Packages:", "", ...rows.map((r) => `- \`${r.pkg}\``), "");

  // ---- search quality ----
  const exposure = buildExposure(catalogs, DEFAULT_OPTIONS, []);
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  const misses = [];
  for (const [q, expected] of QUERIES) {
    if (!exposure.routes.has(expected)) throw new Error(`benchmark query expects unknown tool ${expected}`);
    const ids = exposure.index.search(q, { limit: 5 }).map((h) => h.doc.id);
    const rank = ids.indexOf(expected);
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 3) top3++;
    if (rank >= 0) top5++;
    if (rank !== 0) misses.push({ q, expected, got: ids.slice(0, 3), rank });
  }
  const n = QUERIES.length;
  const rate = (k) => `${Math.round((k / n) * 100)}%`;
  out.push("## find_tools search quality", "");
  out.push(`${n} natural-language queries over all ${totalTools} tools at once (BM25 + stemming + synonyms, no embeddings, no network):`, "");
  out.push("| top-1 | top-3 | top-5 |", "|---:|---:|---:|", `| ${rate(top1)} (${top1}/${n}) | ${rate(top3)} (${top3}/${n}) | ${rate(top5)} (${top5}/${n}) |`, "");
  out.push("Queries where the expected tool was not the first hit:", "");
  out.push("| query | expected | rank | top 3 returned |", "|---|---|---:|---|");
  for (const m of misses) out.push(`| ${m.q} | \`${m.expected}\` | ${m.rank === -1 ? "not in top 5" : m.rank + 1} | ${m.got.map((g) => `\`${g}\``).join(", ")} |`);
  out.push("", "The full query list lives in [`scripts/benchmark.mjs`](../scripts/benchmark.mjs). Reproduce with `npm run bench`.", "");

  const md = out.join("\n");
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(join(ROOT, "docs", "benchmark.md"), md);
  console.log(md);
  console.error("Saved docs/benchmark.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
