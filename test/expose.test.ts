import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS } from "../src/config.js";
import { buildExposure, renderHits, resolvePins, toolId } from "../src/expose.js";
import { capResult } from "../src/proxy.js";
import { countTokens } from "../src/tokens.js";
import type { UpstreamTool } from "../src/types.js";

const tool = (name: string, extra: Partial<UpstreamTool> = {}): UpstreamTool => ({
  name,
  description: `Does ${name}.`,
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
  ...extra,
});

describe("toolId", () => {
  it("joins server and tool and sanitizes", () => {
    expect(toolId("github", "create_issue")).toBe("github__create_issue");
    expect(toolId("my server", "a.b/c")).toBe("my_server__a_b_c");
  });

  it("stays within 64 characters with a stable hash suffix", () => {
    const long = toolId("a-very-long-server-name-indeed", "and_an_even_longer_tool_name_that_goes_on_and_on");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(toolId("a-very-long-server-name-indeed", "and_an_even_longer_tool_name_that_goes_on_and_on")).toBe(long);
    expect(toolId("a-very-long-server-name-indeed", "and_an_even_longer_tool_name_that_goes_on_and_off")).not.toBe(long);
  });
});

describe("pins", () => {
  const ids = ["github__a", "github__b", "fs__read", "fs__write", "mem__x"];
  it("supports exact ids, server__*, prefixes and auto", () => {
    expect([...resolvePins(ids, ["fs__read"], 5)]).toEqual(["fs__read"]);
    expect([...resolvePins(ids, ["github__*"], 5)]).toEqual(["github__a", "github__b"]);
    expect([...resolvePins(ids, ["fs__w*"], 5)]).toEqual(["fs__write"]);
    expect([...resolvePins(ids, ["auto"], 2, ["gone__tool", "mem__x", "fs__read", "github__a"])]).toEqual(["mem__x", "fs__read"]);
    expect([...resolvePins(ids, ["nope"], 5)]).toEqual([]);
  });
});

describe("buildExposure", () => {
  const catalogs = {
    github: [tool("create_issue"), tool("delete_label", { annotations: { destructiveHint: true } }), tool("list_issues")],
    fs: [tool("read_file"), tool("write_file")],
  };

  it("exposes pinned tools plus find_tools, call_tool and slimcp_status", () => {
    const e = buildExposure(catalogs, { ...DEFAULT_OPTIONS, pin: ["fs__read_file"] });
    expect(e.tools.map((t) => t.name)).toEqual(["fs__read_file", "find_tools", "call_tool", "slimcp_status"]);
    expect(e.hiddenCount).toBe(4);
    const find = e.tools.find((t) => t.name === "find_tools")!;
    expect(find.description).toContain("Search 4 hidden MCP tools (listed below)");
    expect(find.description).toContain("before saying a tool is missing");
    expect(find.description).toContain("github: create_issue, delete_label, list_issues");
    expect((find.inputSchema as any).properties.server.enum).toEqual(["github", "fs"]);
    expect(find.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    // call_tool must never look read-only or auto-approvable.
    const call = e.tools.find((t) => t.name === "call_tool")!;
    expect(call.annotations).toEqual({ readOnlyHint: false, openWorldHint: true });
    expect(call.description).toContain("Output over 12,000 tokens is cut");
    expect(call.description).toContain("destructive tools are refused unless pinned");
    const status = e.tools.find((t) => t.name === "slimcp_status")!;
    expect(status.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(status.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("always exposes the meta-tools, even with no servers", () => {
    const e = buildExposure({}, DEFAULT_OPTIONS);
    expect(e.tools.map((t) => t.name)).toEqual(["find_tools", "call_tool", "slimcp_status"]);
    const find = e.tools[0]!;
    expect(find.description).toContain("(none right now)");
    expect((find.inputSchema as any).properties.server.enum).toBeUndefined();
  });

  it("lists only server names with catalog: servers", () => {
    const e = buildExposure(catalogs, { ...DEFAULT_OPTIONS, catalog: "servers" });
    const find = e.tools.find((t) => t.name === "find_tools")!;
    expect(find.description).toContain("github (3), fs (2)");
    expect(find.description).not.toContain("create_issue");
  });

  it("keeps the meta-tools when everything is pinned", () => {
    const e = buildExposure(catalogs, { ...DEFAULT_OPTIONS, pin: ["github__*", "fs__*"] });
    expect(e.hiddenCount).toBe(0);
    expect(e.tools.map((t) => t.name).slice(5)).toEqual(["find_tools", "call_tool", "slimcp_status"]);
  });

  it("auto-pins the most used tools", () => {
    const e = buildExposure(catalogs, { ...DEFAULT_OPTIONS, autoPin: 1 }, ["github__list_issues", "fs__read_file"]);
    expect([...e.pinned]).toEqual(["github__list_issues"]);
  });

  it("renders hits with ids, descriptions, schemas and the destructive marker", () => {
    const e = buildExposure(catalogs, DEFAULT_OPTIONS);
    const text = renderHits(e.index.search("delete label"), { pinned: e.pinned, minify: "safe", gateDestructive: true });
    expect(text).toContain("### github__delete_label (destructive — pin to use)");
    expect(text).toContain('schema: {"type":"object"');
  });
});

describe("capResult", () => {
  it("leaves small results alone", () => {
    const r = { content: [{ type: "text" as const, text: "hello" }] };
    expect(capResult(r, 100)).toBe(r);
  });

  it("truncates huge text, drops structuredContent and explains", () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `word${i}`).join(" ");
    const r = { content: [{ type: "text" as const, text: big }], structuredContent: { a: 1 } };
    const out = capResult(r, 1000);
    expect(out.structuredContent).toBeUndefined();
    const texts = out.content.map((c: any) => c.text);
    expect(countTokens(texts[0])).toBeLessThanOrEqual(1000);
    expect(texts.at(-1)).toMatch(/^\[slimcp: output truncated from [\d,]+ to 1,000 tokens/);
    expect(texts.at(-1)).toContain("ask for a narrower result");
  });

  it("is disabled with maxResultTokens 0", () => {
    const r = { content: [{ type: "text" as const, text: "x ".repeat(50_000) }] };
    expect(capResult(r, 0)).toBe(r);
  });
});
