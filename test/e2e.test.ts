import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { runAudit } from "../src/audit.js";
import { resolveConfig } from "../src/config.js";
import { discoverSources, type DiscoverContext } from "../src/discover.js";
import { applyInit, planInit, readBackups, restore, slimcpEntry } from "../src/init.js";
import { SlimProxy } from "../src/proxy.js";
import { readUsage, writeJsonAtomic } from "../src/state.js";
import { countTokens, toolTokens } from "../src/tokens.js";
import { VERSION } from "../src/version.js";

const FIXTURE = resolve(__dirname, "fixtures", "server.mjs");
const fixture = { command: process.execPath, args: [FIXTURE] };
const isWin = process.platform === "win32";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `slimcp-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function makeCtx(env: Record<string, string> = {}): DiscoverContext {
  return { home: tmp("home"), cwd: tmp("project"), platform: "linux", env };
}

const text = (r: any): string => (r.content as any[]).map((c) => c.text ?? "").join("\n");

describe("discovery", () => {
  it("finds Claude Code (user, local, project), Cursor and VS Code JSONC", () => {
    const ctx = makeCtx();
    writeJson(join(ctx.home, ".claude.json"), {
      numStartups: 3,
      mcpServers: { gh: fixture },
      projects: { [ctx.cwd]: { mcpServers: { localOnly: fixture } } },
    });
    writeJson(join(ctx.cwd, ".mcp.json"), { mcpServers: { proj: fixture, slimcp: { command: "npx" } } });
    writeJson(join(ctx.home, ".cursor", "mcp.json"), { mcpServers: { cur: { url: "https://example.com/mcp" } } });
    writeJson(
      join(ctx.home, ".config", "Code", "User", "mcp.json"),
      `{
        // VS Code user config
        "servers": {
          "vs": { "type": "stdio", "command": "node", "args": ["x.js"], },
          "secret": { "command": "node", "env": { "TOKEN": "\${input:token}" } },
        },
      }`,
    );
    const sources = discoverSources(ctx);
    const summary = sources.map((s) => `${s.clientId}:${s.scope}:${s.servers.map((x) => x.name).join(",")}`);
    expect(summary).toEqual([
      "claude-code:user:gh",
      "claude-code:local:localOnly",
      "claude-code:project:proj",
      "cursor:user:cur",
      "vscode:user:vs,secret",
    ]);
    const vs = sources.find((s) => s.clientId === "vscode")!;
    expect(vs.format).toBe("jsonc");
    expect(vs.servers[1]!.unresolved).toEqual(["${input:token}"]);
    expect(sources.find((s) => s.clientId === "cursor")!.native).toContain("dynamic context discovery");
  });
});

describe("audit", () => {
  it("measures the fixture, reports failures and marks native clients", async () => {
    const ctx = makeCtx({ ENABLE_TOOL_SEARCH: "false" });
    const home = tmp("state");
    writeJson(join(ctx.home, ".config", "Claude", "claude_desktop_config.json"), {
      mcpServers: { github: fixture, broken: { command: "slimcp-definitely-missing-binary" } },
    });
    writeJson(join(ctx.home, ".cursor", "mcp.json"), { mcpServers: { github: fixture } });
    writeJson(join(ctx.home, ".claude.json"), { mcpServers: { github: fixture } });

    const result = await runAudit({ ctx, home, timeoutMs: 30_000 });
    // Clients that pay full price come first; natively deferring ones last.
    expect(result.clients.map((c) => c.id).sort()).toEqual(["claude-code", "claude-desktop", "cursor"]);
    expect(result.clients.at(-1)!.id).toBe("cursor");

    const desktop = result.clients.find((c) => c.id === "claude-desktop")!;
    const gh = desktop.servers.find((s) => s.name === "github")!;
    expect(gh.tools).toBe(42);
    expect(gh.tokens).toBeGreaterThan(5000);
    expect(desktop.slimTokens).toBeLessThan(desktop.totalTokens * 0.2);
    expect(desktop.servers.find((s) => s.name === "broken")!.error).toMatch(/not found|ENOENT|spawn/i);

    const code = result.clients.find((c) => c.id === "claude-code")!;
    expect(code.native).toBeUndefined();
    expect(code.toolSearch).toMatchObject({ enabled: false });

    const cursor = result.clients.find((c) => c.id === "cursor")!;
    expect(cursor.native).toBeDefined();
    expect(result.heaviest).toHaveLength(5);

    // Offline mode reuses the cache.
    const cached = await runAudit({ ctx, home, cached: true });
    expect(cached.clients.find((c) => c.id === "claude-desktop")!.servers.find((s) => s.name === "github")!.tools).toBe(42);
  });
});

async function startProxy(home: string, extra: Record<string, unknown> = {}) {
  const config = resolveConfig({ servers: { github: fixture }, ...extra }, {}, "/tmp/slimcp-test.json");
  const proxy = new SlimProxy(config, { home, usageDebounceMs: 10 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    proxy,
    client,
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await proxy.close();
    },
  };
}

describe("proxy", () => {
  const home = tmp("proxy-state");
  const repo = { owner: "octocat", repo: "hello" };

  it("exposes pinned tools + 3 meta-tools in under 800 tokens and routes calls", async () => {
    const p = await startProxy(home, { pin: ["auto", "github__get_issue"] });
    try {
      const { tools } = await p.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["github__get_issue", "find_tools", "call_tool", "slimcp_status"]);
      const tokens = tools.reduce((a, t) => a + toolTokens(t as any), 0);
      expect(tokens).toBeLessThan(800);

      const found = await p.call("find_tools", { query: "remove a label" });
      expect(text(found)).toContain("### github__delete_label");
      expect(text(found)).toContain("destructive — pin to use");

      const listing = await p.call("find_tools", { query: "", server: "github" });
      expect(text(listing).split("\n")).toHaveLength(42);

      const pinned = await p.call("github__get_issue", { ...repo, number: 1 });
      expect(text(pinned)).toContain('"tool":"get_issue"');

      const meta = await p.call("call_tool", { name: "github__create_issue", arguments: { ...repo, title: "x" } });
      expect(meta.isError).toBeFalsy();
      expect(text(meta)).toContain('"tool":"create_issue"');

      const bare = await p.call("call_tool", { name: "list_label", arguments: JSON.stringify(repo) });
      expect(text(bare)).toContain('"tool":"list_label"');

      const dotted = await p.call("call_tool", { name: "github.search_issue", arguments: repo });
      expect(text(dotted)).toContain('"tool":"search_issue"');

      const typo = await p.call("call_tool", { name: "github__create_isue", arguments: repo });
      expect(typo.isError).toBe(true);
      expect(text(typo)).toContain("Did you mean github__create_issue");

      const giant = await p.call("call_tool", { name: "github__get_release", arguments: { ...repo, number: 1, big: true } });
      expect(giant.structuredContent).toBeUndefined();
      expect(text(giant)).toMatch(/\[slimcp: output truncated from [\d,]+ to 12,000 tokens/);
      expect(countTokens(text(giant))).toBeLessThan(12_100);

      const blocked = await p.call("call_tool", { name: "github__delete_label", arguments: { ...repo, number: 1 } });
      expect(blocked.isError).toBe(true);
      expect(text(blocked)).toContain('"pin": ["auto", "github__delete_label"]');
      const blockedDirect = await p.call("github__delete_label", { ...repo, number: 1 });
      expect(blockedDirect.isError).toBe(true);
    } finally {
      await p.close();
    }
    const usage = readUsage(home);
    expect(usage.tools["github__get_issue"]!.calls).toBe(1);
    expect(usage.tools["github__create_issue"]!.calls).toBe(1);
    expect(usage.tools["github__delete_label"]).toBeUndefined();
  });

  it("starts lazily from cache and runs destructive tools once pinned", async () => {
    const p = await startProxy(home, { pin: ["github__delete_label"] });
    try {
      const { tools } = await p.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["github__delete_label", "find_tools", "call_tool", "slimcp_status"]);
      expect(tools[0]!.annotations).toMatchObject({ destructiveHint: true });
      // Served from the catalog cache: nothing spawned yet.
      expect(p.proxy.serverStatus()[0]).toMatchObject({ name: "github", tools: 42, connected: false });
      const status = await p.call("slimcp_status");
      expect(text(status)).toContain("- github: cached (starts on first call), 42 tools");
      expect(p.proxy.serverStatus()[0]!.connected).toBe(false); // status does not start servers

      const ok = await p.call("github__delete_label", { ...repo, number: 1 });
      expect(ok.isError).toBeFalsy();
      expect(text(ok)).toContain('"tool":"delete_label"');
      expect(p.proxy.serverStatus()[0]!.connected).toBe(true);

      const viaMeta = await p.call("call_tool", { name: "github__delete_label", arguments: { ...repo, number: 1 } });
      expect(viaMeta.isError).toBe(true);
      expect(text(viaMeta)).toContain("call it directly as github__delete_label");
    } finally {
      await p.close();
    }
    expect(p.proxy.serverStatus()[0]!.connected).toBe(false);
  });

  it("auto-pins the most used tools from local stats", async () => {
    const usage = readUsage(home);
    usage.tools["github__create_issue"] = { calls: 100, lastUsed: new Date().toISOString() };
    usage.tools["github__get_issue"] = { calls: 50, lastUsed: new Date().toISOString() };
    writeJsonAtomic(join(home, "usage.json"), usage);
    const p = await startProxy(home, { autoPin: 2 });
    try {
      const { tools } = await p.client.listTools();
      expect(tools.map((t) => t.name).slice(0, 2).sort()).toEqual(["github__create_issue", "github__get_issue"].sort());
    } finally {
      await p.close();
    }
  });

  it("runs with no upstream servers and still lists the meta-tools", async () => {
    const p = await startProxy(tmp("empty-state"), { servers: {} });
    try {
      const { tools } = await p.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["find_tools", "call_tool", "slimcp_status"]);
      const status = await p.call("slimcp_status");
      expect(status.isError).toBeFalsy();
      expect(text(status)).toContain("0 MCP servers configured");
      expect(text(status)).toContain("No upstream servers yet");
      const found = await p.call("find_tools", { query: "open a pull request" });
      expect(found.isError).toBeFalsy();
      expect(text(found)).toContain("No tools matched");
      const missing = await p.call("call_tool", { name: "github__create_issue", arguments: {} });
      expect(missing.isError).toBe(true);
    } finally {
      await p.close();
    }
  });

  it("slimcp_status reports connected servers, savings and failures with errors", async () => {
    const p = await startProxy(tmp("status-state"), {
      servers: { github: fixture, broken: { command: "slimcp-definitely-missing-binary" }, off: { command: "x", disabled: true } },
    });
    try {
      const status = await p.call("slimcp_status");
      const t = text(status);
      expect(t).toContain("3 MCP servers configured");
      expect(t).toContain("- github: connected, 42 tools");
      expect(t).toMatch(/- broken: failed, 0 tools — .*(not found|ENOENT|spawn)/i);
      expect(t).toContain("- off: disabled in config, 0 tools");
      expect(t).toMatch(/saving ≈[\d,]+ \(−\d+%\)/);
      const s = status.structuredContent as any;
      expect(s.totalTools).toBe(42);
      expect(s.savedTokens).toBeGreaterThan(4000);
      expect(s.servers.find((x: any) => x.name === "broken").error).toBeTruthy();
    } finally {
      await p.close();
    }
  });

  it("allowDestructiveViaCallTool turns the gate off", async () => {
    const p = await startProxy(home, { allowDestructiveViaCallTool: true });
    try {
      const r = await p.call("call_tool", { name: "github__delete_milestone", arguments: { ...repo, number: 2 } });
      expect(r.isError).toBeFalsy();
    } finally {
      await p.close();
    }
  });
});

describe("init + restore", () => {
  it("dry run, apply, preserve other keys, pin the version, 0600 files, byte-identical restore", () => {
    const ctx = makeCtx();
    const home = join(tmp("state"), ".slimcp");
    const claudeJson = join(ctx.home, ".claude.json");
    const desktopJson = join(ctx.home, ".config", "Claude", "claude_desktop_config.json");
    writeJson(claudeJson, {
      numStartups: 42,
      oauthAccount: { emailAddress: "someone@example.com" },
      projects: { "/some/repo": { allowedTools: ["Bash"], mcpServers: { private: fixture } } },
      mcpServers: { github: { ...fixture, env: { GITHUB_TOKEN: "fake-token-for-tests" } }, keepme: fixture, off: { command: "x", disabled: true } },
    });
    writeJson(desktopJson, `{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  },\n  "theme": "dark"\n}\n`);
    const before = { code: readFileSync(claudeJson), desktop: readFileSync(desktopJson) };

    // Claude Code has native tool search on, so it is skipped unless named.
    const auto = planInit({ ctx, home });
    expect(auto.changes.map((c) => c.source.clientId)).toEqual(["claude-desktop"]);
    expect(auto.skipped.some((s) => s.client === "Claude Code" && /natively|tool search/i.test(s.reason))).toBe(true);

    const plan = planInit({ ctx, home, clients: ["claude-code", "claude-desktop"], keep: ["keepme"] });
    expect(plan.changes.map((c) => `${c.source.clientId}:${c.move.join(",")}`)).toEqual(["claude-code:github", "claude-desktop:github"]);
    expect(plan.warnings.join(" ")).toContain("Quit Claude Code");
    // Dry run changes nothing.
    expect(readFileSync(claudeJson).equals(before.code)).toBe(true);

    applyInit(plan);
    const code = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(code.numStartups).toBe(42);
    expect(code.oauthAccount).toEqual({ emailAddress: "someone@example.com" });
    expect(code.projects["/some/repo"]).toEqual({ allowedTools: ["Bash"], mcpServers: { private: fixture } });
    expect(Object.keys(code.mcpServers)).toEqual(["keepme", "off", "slimcp"]);
    const args: string[] = code.mcpServers.slimcp.args;
    expect(code.mcpServers.slimcp.command).toBe("npx");
    expect(args).toContain(`slimcp@${VERSION}`);
    expect(args.join(" ")).not.toContain("latest");
    const slimPath = args[args.indexOf("--config") + 1]!;
    const slim = JSON.parse(readFileSync(slimPath, "utf8"));
    expect(slim.servers.github.env.GITHUB_TOKEN).toBe("fake-token-for-tests");

    const desktop = JSON.parse(readFileSync(desktopJson, "utf8"));
    expect(desktop.theme).toBe("dark");
    expect(Object.keys(desktop.mcpServers)).toEqual(["slimcp"]);

    const backups = readBackups(home);
    expect(backups).toHaveLength(2);
    if (!isWin) {
      expect(statSync(slimPath).mode & 0o777).toBe(0o600);
      for (const b of backups) expect(statSync(b.backup).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }

    // Running init again merges into the same slimcp config.
    writeJson(desktopJson, { ...desktop, mcpServers: { ...desktop.mcpServers, extra: fixture } });
    applyInit(planInit({ ctx, home, clients: ["claude-desktop"] }));
    const merged = JSON.parse(readFileSync(join(home, "claude-desktop-user.json"), "utf8"));
    expect(Object.keys(merged.servers).sort()).toEqual(["extra", "github"]);

    const r = restore(home);
    expect(r.restored).toHaveLength(2);
    expect(readFileSync(claudeJson).equals(before.code)).toBe(true);
    expect(readFileSync(desktopJson).equals(before.desktop)).toBe(true);
    expect(readBackups(home)).toHaveLength(0);
  });

  it("uses cmd /c on Windows and type stdio for VS Code", () => {
    expect(slimcpEntry("claude-desktop", "win32", "C:\\x.json", "1.2.3")).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "slimcp@1.2.3", "serve", "--config", "C:\\x.json"],
    });
    expect(slimcpEntry("vscode", "darwin", "/x.json", "1.2.3")).toMatchObject({ type: "stdio", command: "npx" });
  });

  it("prints a manual snippet for Codex TOML and skips project configs without --project", () => {
    const ctx = makeCtx();
    const home = tmp("state");
    writeJson(join(ctx.home, ".codex", "config.toml"), `[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n`);
    writeJson(join(ctx.cwd, ".mcp.json"), { mcpServers: { proj: fixture } });
    const plan = planInit({ ctx, home, clients: ["codex", "claude-code"] });
    expect(plan.changes).toHaveLength(0);
    expect(plan.manual[0]!.snippet).toContain("[mcp_servers.slimcp]");
    expect(plan.manual[0]!.snippet).toContain(`slimcp@${VERSION}`);
    expect(plan.skipped.some((s) => s.scope === "project" && s.reason.includes("--project"))).toBe(true);
    const withProject = planInit({ ctx, home, clients: ["claude-code"], project: true });
    expect(withProject.changes[0]!.slimConfigPath).toMatch(/claude-code-project-[0-9a-f]{8}\.json$/);
  });
});
