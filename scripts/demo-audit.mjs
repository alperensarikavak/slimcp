#!/usr/bin/env node
// Runs the REAL audit against a throwaway Claude Desktop config that points at
// five of the benchmark servers in .bench/ (run `npm run bench` first).
// Used to produce the output shown in assets/demo.svg.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = join(ROOT, ".bench");
const { runAudit, renderReport } = await import(pathToFileURL(join(ROOT, "dist", "index.js")).href);

const bin = (pkg) => {
  const dir = join(BENCH, "node_modules", pkg);
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return join(dir, typeof json.bin === "string" ? json.bin : Object.values(json.bin)[0]);
};
const node = (pkg, args = [], env) => ({ command: process.execPath, args: [bin(pkg), ...args], ...(env ? { env } : {}) });

const home = mkdtempSync(join(tmpdir(), "slimcp-demo-"));
const cfg = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
mkdirSync(dirname(cfg), { recursive: true });
writeFileSync(
  cfg,
  JSON.stringify({
    mcpServers: {
      github: node("@modelcontextprotocol/server-github", [], { GITHUB_PERSONAL_ACCESS_TOKEN: "dummy" }),
      notion: node("@notionhq/notion-mcp-server"),
      playwright: node("@playwright/mcp"),
      filesystem: node("@modelcontextprotocol/server-filesystem", [join(BENCH, "sandbox")]),
      memory: node("@modelcontextprotocol/server-memory", [], { MEMORY_FILE_PATH: join(BENCH, "sandbox", "memory.json") }),
    },
  }),
);
const result = await runAudit({
  ctx: { home, cwd: home, platform: "darwin", env: {} },
  home: join(BENCH, "state"),
  timeoutMs: 90_000,
});
console.log(renderReport(result, { color: false, home }));
