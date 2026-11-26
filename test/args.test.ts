import { describe, expect, it } from "vitest";
import { guessName, parseArgs } from "../src/args.js";
import { claudeCodeToolSearch, CLIENTS } from "../src/discover.js";

describe("parseArgs", () => {
  it("parses commands, value flags, booleans and passthrough", () => {
    const a = parseArgs(["init", "--client", "cursor,vscode", "--yes", "--keep=github", "--project"]);
    expect(a.command).toBe("init");
    expect(a.flags).toEqual({ client: "cursor,vscode", yes: true, keep: "github", project: true });
    const w = parseArgs(["wrap", "--name", "gh", "--", "npx", "-y", "--foo", "@x/y"]);
    expect(w.command).toBe("wrap");
    expect(w.flags.name).toBe("gh");
    expect(w.passthrough).toEqual(["npx", "-y", "--foo", "@x/y"]);
  });

  it("handles short flags and --version", () => {
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["--version"]).flags.version).toBe(true);
    expect(parseArgs(["init", "-y"]).flags.yes).toBe(true);
  });

  it("does not swallow a following flag as a value", () => {
    expect(parseArgs(["audit", "--client", "--json"]).flags).toEqual({ client: true, json: true });
  });
});

describe("guessName", () => {
  it.each([
    [["npx", "-y", "@modelcontextprotocol/server-github"], "github"],
    [["uvx", "mcp-server-fetch"], "fetch"],
    [["npx", "@playwright/mcp@latest"], "playwright"],
    [["npx", "-y", "@notionhq/notion-mcp-server"], "notion"],
    [["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "filesystem"],
    [["python", "-m", "mcp_server_time"], "time"],
    [["/usr/local/bin/my-tool-mcp"], "my-tool"],
    [["node", "./build/index.js"], "index"],
  ])("%j → %s", (argv, name) => {
    const [cmd, ...args] = argv as string[];
    expect(guessName(cmd!, args)).toBe(name);
  });
});

describe("native deferral detection", () => {
  const cc = CLIENTS.find((c) => c.id === "claude-code")!;
  const cursor = CLIENTS.find((c) => c.id === "cursor")!;

  it("Claude Code tool search is on by default", () => {
    expect(claudeCodeToolSearch({})).toMatchObject({ enabled: true, mode: "on" });
    expect(cc.nativeDeferral!({})).toBeDefined();
  });

  it("is turned off by ENABLE_TOOL_SEARCH=false and auto:100", () => {
    expect(cc.nativeDeferral!({ ENABLE_TOOL_SEARCH: "false" })).toBeUndefined();
    expect(cc.nativeDeferral!({ ENABLE_TOOL_SEARCH: "auto:100" })).toBeUndefined();
    expect(claudeCodeToolSearch({ ENABLE_TOOL_SEARCH: "false" }).reason).toContain("ENABLE_TOOL_SEARCH");
  });

  it("auto and auto:N mean threshold-based deferral", () => {
    expect(claudeCodeToolSearch({ ENABLE_TOOL_SEARCH: "auto" })).toMatchObject({ enabled: true, mode: "auto" });
    expect(claudeCodeToolSearch({ ENABLE_TOOL_SEARCH: "auto:5" })).toMatchObject({ enabled: true, mode: "auto" });
    expect(claudeCodeToolSearch({ ENABLE_TOOL_SEARCH: "auto:5" }).reason).toContain("5%");
  });

  it("is turned off by a truthy CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", () => {
    expect(cc.nativeDeferral!({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" })).toBeUndefined();
    expect(cc.nativeDeferral!({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "true" })).toBeUndefined();
    expect(cc.nativeDeferral!({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "0" })).toBeDefined();
  });

  it("is turned off by a non-Anthropic ANTHROPIC_BASE_URL gateway", () => {
    expect(cc.nativeDeferral!({ ANTHROPIC_BASE_URL: "https://litellm.internal:4000" })).toBeUndefined();
    expect(claudeCodeToolSearch({ ANTHROPIC_BASE_URL: "https://litellm.internal:4000" }).reason).toContain("litellm.internal");
    expect(cc.nativeDeferral!({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBeDefined();
    // an explicit opt-in wins over the gateway
    expect(cc.nativeDeferral!({ ANTHROPIC_BASE_URL: "https://gw.example", ENABLE_TOOL_SEARCH: "true" })).toBeDefined();
  });

  it("Cursor always defers; the others never do", () => {
    expect(cursor.nativeDeferral!({})).toContain("dynamic context discovery");
    for (const c of CLIENTS.filter((c) => c.id !== "cursor" && c.id !== "claude-code")) expect(c.nativeDeferral).toBeUndefined();
  });
});
