import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { normalizeServers, parseJsonc } from "./normalize.js";
import type { ConfigFormat, ConfigScope, ConfigSource } from "./types.js";

/** Everything discovery depends on, injectable for tests. */
export interface DiscoverContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export function defaultContext(overrides: Partial<DiscoverContext> = {}): DiscoverContext {
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
    ...overrides,
  };
}

/** Per-OS "application data" folder (where Electron apps keep their config). */
export function appDataDir(ctx: DiscoverContext): string {
  if (ctx.platform === "darwin") return join(ctx.home, "Library", "Application Support");
  if (ctx.platform === "win32") return ctx.env.APPDATA || join(ctx.home, "AppData", "Roaming");
  return ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config");
}

export interface SourceLocation {
  path: string;
  /** Key path to the server map. Resolved against the parsed file. */
  keyPath: string[];
  scope: ConfigScope;
  format: ConfigFormat;
}

export interface ClientDef {
  id: string;
  name: string;
  locations(ctx: DiscoverContext): SourceLocation[];
  /** Returns a note when the client already defers MCP tools natively, otherwise undefined. */
  nativeDeferral?(env: Record<string, string | undefined>): string | undefined;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const isTruthy = (v: string | undefined) => v !== undefined && TRUTHY.has(v.trim().toLowerCase());

export interface ToolSearchStatus {
  enabled: boolean;
  mode: "on" | "auto" | "off";
  reason: string;
}

/**
 * Claude Code's built-in MCP "tool search" (deferred tool loading).
 * On by default; turned off by ENABLE_TOOL_SEARCH=false or auto:100, by a
 * truthy CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, or by routing through a
 * non-Anthropic ANTHROPIC_BASE_URL gateway (unless explicitly re-enabled).
 */
export function claudeCodeToolSearch(env: Record<string, string | undefined>): ToolSearchStatus {
  const raw = (env.ENABLE_TOOL_SEARCH ?? "").trim().toLowerCase();
  if (isTruthy(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return { enabled: false, mode: "off", reason: "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set, which turns tool search off" };
  }
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") {
    return { enabled: false, mode: "off", reason: `ENABLE_TOOL_SEARCH=${env.ENABLE_TOOL_SEARCH} turns tool search off` };
  }
  const auto = /^auto(?::(\d+(?:\.\d+)?))?$/.exec(raw);
  if (auto) {
    const pct = auto[1] === undefined ? undefined : Number(auto[1]);
    if (pct !== undefined && pct >= 100) {
      return { enabled: false, mode: "off", reason: `ENABLE_TOOL_SEARCH=${env.ENABLE_TOOL_SEARCH} never reaches its threshold, so tools always load up front` };
    }
  }
  const explicitOn = raw === "true" || raw === "1" || raw === "on" || raw === "yes";
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (base && !explicitOn && !isAnthropicHost(base)) {
    return { enabled: false, mode: "off", reason: `ANTHROPIC_BASE_URL points at a non-Anthropic gateway (${safeHost(base)}), which turns tool search off` };
  }
  if (auto) {
    const pct = auto[1] ?? "10";
    return { enabled: true, mode: "auto", reason: `tool search defers MCP tools once they exceed ${pct}% of the context (ENABLE_TOOL_SEARCH=${env.ENABLE_TOOL_SEARCH})` };
  }
  return { enabled: true, mode: "on", reason: "Claude Code's tool search defers MCP tools" };
}

function isAnthropicHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid URL";
  }
}

export const CLIENTS: ClientDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    locations: (ctx) => {
      const file = join(ctx.home, ".claude.json");
      return [
        { path: file, keyPath: ["mcpServers"], scope: "user", format: "json" },
        { path: file, keyPath: ["projects", ctx.cwd, "mcpServers"], scope: "local", format: "json" },
        { path: join(ctx.cwd, ".mcp.json"), keyPath: ["mcpServers"], scope: "project", format: "json" },
      ];
    },
    nativeDeferral: (env) => {
      const s = claudeCodeToolSearch(env);
      return s.enabled ? s.reason : undefined;
    },
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    locations: (ctx) => [
      { path: join(appDataDir(ctx), "Claude", "claude_desktop_config.json"), keyPath: ["mcpServers"], scope: "user", format: "json" },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    locations: (ctx) => [
      { path: join(ctx.home, ".cursor", "mcp.json"), keyPath: ["mcpServers"], scope: "user", format: "json" },
      { path: join(ctx.cwd, ".cursor", "mcp.json"), keyPath: ["mcpServers"], scope: "project", format: "json" },
    ],
    nativeDeferral: () => "Cursor loads MCP tools on demand (dynamic context discovery)",
  },
  {
    id: "vscode",
    name: "VS Code",
    locations: (ctx) => [
      { path: join(appDataDir(ctx), "Code", "User", "mcp.json"), keyPath: ["servers"], scope: "user", format: "jsonc" },
      { path: join(ctx.cwd, ".vscode", "mcp.json"), keyPath: ["servers"], scope: "project", format: "jsonc" },
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    locations: (ctx) => [
      { path: join(ctx.home, ".codeium", "windsurf", "mcp_config.json"), keyPath: ["mcpServers"], scope: "user", format: "json" },
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    locations: (ctx) => [
      { path: join(ctx.home, ".gemini", "settings.json"), keyPath: ["mcpServers"], scope: "user", format: "jsonc" },
      { path: join(ctx.cwd, ".gemini", "settings.json"), keyPath: ["mcpServers"], scope: "project", format: "jsonc" },
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    locations: (ctx) => [
      { path: join(ctx.env.CODEX_HOME || join(ctx.home, ".codex"), "config.toml"), keyPath: ["mcp_servers"], scope: "user", format: "toml" },
    ],
  },
];

export function findClient(id: string): ClientDef | undefined {
  const q = id.toLowerCase().replace(/[\s_]/g, "-");
  return CLIENTS.find((c) => c.id === q || c.name.toLowerCase().replace(/\s/g, "-") === q);
}

export function parseConfigText(text: string, format: ConfigFormat): unknown {
  if (format === "toml") return parseToml(text);
  return parseJsonc(text);
}

/** Walk a key path. A key matching a path is compared loosely (slashes, case on Windows). */
export function getAtPath(obj: unknown, keyPath: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keyPath) {
    if (typeof cur !== "object" || cur === null) return undefined;
    const rec = cur as Record<string, unknown>;
    if (key in rec) {
      cur = rec[key];
      continue;
    }
    const match = Object.keys(rec).find((k) => samePath(k, key));
    if (match === undefined) return undefined;
    cur = rec[match];
  }
  return cur;
}

/** Like getAtPath but returns the actual key names found in the file. */
export function resolveKeyPath(obj: unknown, keyPath: string[]): string[] | undefined {
  let cur: unknown = obj;
  const out: string[] = [];
  for (const key of keyPath) {
    if (typeof cur !== "object" || cur === null) return undefined;
    const rec = cur as Record<string, unknown>;
    const match = key in rec ? key : Object.keys(rec).find((k) => samePath(k, key));
    if (match === undefined) return undefined;
    out.push(match);
    cur = rec[match];
  }
  return out;
}

function samePath(a: string, b: string): boolean {
  if (!/[\\/]/.test(a) || !/[\\/]/.test(b)) return false;
  const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Read every known client config and return the server blocks found. */
export function discoverSources(ctx: DiscoverContext = defaultContext(), only?: string[]): ConfigSource[] {
  const out: ConfigSource[] = [];
  const wanted = only?.map((c) => findClient(c)?.id ?? c);
  for (const client of CLIENTS) {
    if (wanted && !wanted.includes(client.id)) continue;
    const native = client.nativeDeferral?.(ctx.env);
    const seen = new Set<string>();
    for (const loc of client.locations(ctx)) {
      const dedupeKey = `${resolve(loc.path)}#${loc.keyPath.join("/")}`;
      if (seen.has(dedupeKey)) continue; // e.g. cwd === home
      seen.add(dedupeKey);
      if (!existsSync(loc.path)) continue;
      const base = {
        clientId: client.id,
        clientName: client.name,
        scope: loc.scope,
        path: loc.path,
        keyPath: loc.keyPath,
        format: loc.format,
        ...(native ? { native } : {}),
      };
      let parsed: unknown;
      try {
        parsed = parseConfigText(readFileSync(loc.path, "utf8"), loc.format);
      } catch (e) {
        out.push({ ...base, servers: [], raw: {}, error: `could not parse ${loc.path}: ${(e as Error).message}` });
        continue;
      }
      const map = getAtPath(parsed, loc.keyPath);
      if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
      const raw = map as Record<string, unknown>;
      const servers = normalizeServers(raw, { env: ctx.env, home: ctx.home, cwd: ctx.cwd });
      if (!servers.length) continue;
      out.push({ ...base, keyPath: resolveKeyPath(parsed, loc.keyPath) ?? loc.keyPath, servers, raw });
    }
  }
  return out;
}
