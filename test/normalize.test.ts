import { describe, expect, it } from "vitest";
import { expandVars, normalizeServer, parseJsonc } from "../src/normalize.js";

describe("parseJsonc", () => {
  it("strips line and block comments and trailing commas", () => {
    const text = `{
      // a comment
      "servers": {
        /* block
           comment */
        "a": { "command": "x", "args": ["1", "2",], },
      },
    }`;
    expect(parseJsonc(text)).toEqual({ servers: { a: { command: "x", args: ["1", "2"] } } });
  });

  it("never strips // or /* inside strings", () => {
    const text = `{ "url": "https://example.com/mcp", "glob": "src/**/*.ts", "q": "say \\"hi\\" // not a comment", }`;
    expect(parseJsonc(text)).toEqual({ url: "https://example.com/mcp", glob: "src/**/*.ts", q: 'say "hi" // not a comment' });
  });

  it("keeps commas inside strings and handles a BOM", () => {
    expect(parseJsonc('﻿{"a": "x, }", "b": [1,],}')).toEqual({ a: "x, }", b: [1] });
  });
});

describe("expandVars", () => {
  const env = { TOKEN: "abc", EMPTY: "" };
  it("expands ${VAR}, ${VAR:-default} and ${env:VAR}", () => {
    expect(expandVars("Bearer ${TOKEN}", { env })).toBe("Bearer abc");
    expect(expandVars("${MISSING:-fallback}", { env })).toBe("fallback");
    expect(expandVars("${EMPTY:-fallback}", { env })).toBe("fallback");
    expect(expandVars("${env:TOKEN}", { env })).toBe("abc");
    expect(expandVars("${MISSING}", { env })).toBe("");
  });

  it("expands VS Code workspace variables and leaves ${input:...} unresolved", () => {
    const unresolved: string[] = [];
    expect(expandVars("${workspaceFolder}/x", { env, cwd: "/repo" })).toBe("/repo/x");
    expect(expandVars("${input:gh_token}", { env }, unresolved)).toBe("${input:gh_token}");
    expect(unresolved).toEqual(["${input:gh_token}"]);
  });
});

describe("normalizeServer", () => {
  const ctx = { env: { KEY: "k" } };
  it("stdio with command/args/env/cwd", () => {
    expect(normalizeServer("gh", { command: "npx", args: ["-y", "x"], env: { T: "${KEY}" }, cwd: "/tmp" }, ctx)).toEqual({
      name: "gh",
      transport: "stdio",
      command: "npx",
      args: ["-y", "x"],
      env: { T: "k" },
      cwd: "/tmp",
    });
  });

  it("detects transports across client formats", () => {
    expect(normalizeServer("a", { url: "https://x/mcp" }, ctx).transport).toBe("http");
    expect(normalizeServer("a", { serverUrl: "https://x/mcp" }, ctx)).toMatchObject({ transport: "http", url: "https://x/mcp" });
    expect(normalizeServer("a", { httpUrl: "https://x/mcp" }, ctx)).toMatchObject({ transport: "http", url: "https://x/mcp" });
    expect(normalizeServer("a", { type: "sse", url: "https://x/sse" }, ctx).transport).toBe("sse");
    expect(normalizeServer("a", { type: "streamable-http", url: "https://x" }, ctx).transport).toBe("http");
    expect(normalizeServer("a", { type: "http", url: "https://x" }, ctx).transport).toBe("http");
    expect(normalizeServer("a", { type: "stdio", command: "x" }, ctx).transport).toBe("stdio");
  });

  it("reads headers and http_headers, disabled and enabled:false", () => {
    expect(normalizeServer("a", { url: "https://x", headers: { Authorization: "Bearer ${KEY}" } }, ctx).headers).toEqual({
      Authorization: "Bearer k",
    });
    expect(normalizeServer("a", { url: "https://x", http_headers: { X: "1" } }, ctx).headers).toEqual({ X: "1" });
    expect(normalizeServer("a", { command: "x", disabled: true }, ctx).disabled).toBe(true);
    expect(normalizeServer("a", { command: "x", enabled: false }, ctx).disabled).toBe(true);
    expect(normalizeServer("a", { command: "x" }, ctx).disabled).toBeUndefined();
  });

  it("marks VS Code ${input:...} as unresolved", () => {
    const s = normalizeServer("a", { command: "x", env: { TOKEN: "${input:token}" } }, ctx);
    expect(s.unresolved).toEqual(["${input:token}"]);
  });
});
