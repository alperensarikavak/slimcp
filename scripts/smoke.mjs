#!/usr/bin/env node
// Runtime smoke test without vitest, so CI can check every supported Node version
// (vitest 4 itself needs Node 20+). Runs the built CLI as an MCP server over stdio,
// wrapping the 42-tool fixture, and checks list / search / call / shutdown.
//
//   npm run build && node scripts/smoke.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "slimcp-smoke-"));
const text = (r) => r.content.map((c) => c.text ?? "").join("\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "cli.js"), "wrap", "--name", "github", "--", process.execPath, join(ROOT, "test", "fixtures", "server.mjs")],
  env: { ...process.env, SLIMCP_HOME: home },
  stderr: "pipe",
});
const client = new Client({ name: "slimcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  assert.match(client.getServerVersion()?.name ?? "", /slimcp/);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["find_tools", "call_tool", "slimcp_status"]);

  const found = await client.callTool({ name: "find_tools", arguments: { query: "remove a label" } });
  assert.ok(text(found).includes("### github__delete_label"), "search finds delete_label");

  const called = await client.callTool({ name: "call_tool", arguments: { name: "github__get_issue", arguments: { owner: "o", repo: "r", number: 1 } } });
  assert.ok(!called.isError && text(called).includes('"tool":"get_issue"'), "call_tool routes to the fixture");

  const gated = await client.callTool({ name: "call_tool", arguments: { name: "github__delete_label", arguments: { owner: "o", repo: "r", number: 1 } } });
  assert.equal(gated.isError, true, "destructive tool is gated");

  const status = await client.callTool({ name: "slimcp_status", arguments: {} });
  assert.ok(text(status).includes("- github: connected, 42 tools"), "status reports the server");

  console.log(`smoke ok on Node ${process.version}: ${tools.length} tools listed, search, call, gate and status work`);
} finally {
  await client.close();
  rmSync(home, { recursive: true, force: true });
}
