import type { ServerSpec, TransportKind } from "./types.js";

/**
 * Parse JSON with comments (`//`, `/* *\/`) and trailing commas, as used by
 * VS Code and friends. Comment markers inside strings are left alone.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  // Strip a UTF-8 BOM.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // Copy a whole string literal, honoring escapes.
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Remove trailing commas (outside strings: run the same scanner again).
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export interface ExpandContext {
  env: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
}

const VAR_RE = /\$\{([^}]+)\}/g;

/**
 * Expand `${VAR}`, `${VAR:-default}` and `${env:VAR}`. VS Code's
 * `${workspaceFolder}` and `${userHome}` are expanded too. `${input:...}`
 * placeholders are left as-is and reported back as unresolved.
 */
export function expandVars(value: string, ctx: ExpandContext, unresolved?: string[]): string {
  return value.replace(VAR_RE, (whole, body: string) => {
    if (body.startsWith("input:")) {
      unresolved?.push(whole);
      return whole;
    }
    if (body === "workspaceFolder" && ctx.cwd) return ctx.cwd;
    if (body === "userHome" && ctx.home) return ctx.home;
    let name = body;
    let fallback: string | undefined;
    if (name.startsWith("env:")) name = name.slice(4);
    const dflt = name.indexOf(":-");
    if (dflt !== -1) {
      fallback = name.slice(dflt + 2);
      name = name.slice(0, dflt);
    }
    const v = ctx.env[name];
    if (v !== undefined && v !== "") return v;
    return fallback ?? "";
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown, ctx: ExpandContext, unresolved: string[]): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null) continue;
    out[k] = expandVars(String(val), ctx, unresolved);
  }
  return out;
}

function transportFromType(type: unknown): TransportKind | undefined {
  if (typeof type !== "string") return undefined;
  const t = type.toLowerCase().replace(/[_\s]/g, "-");
  if (t === "stdio" || t === "local") return "stdio";
  if (t === "sse") return "sse";
  if (t === "http" || t === "streamable-http" || t === "streamablehttp" || t === "remote") return "http";
  return undefined;
}

/**
 * Turn one server entry from any supported client config into a ServerSpec.
 * Handles `command/args/env/cwd`, `url`, `serverUrl` (Windsurf), `httpUrl`
 * (Gemini), `type`/`transport`, `disabled`/`enabled`, `headers`/`http_headers`
 * and Codex's `bearer_token_env_var`.
 */
export function normalizeServer(name: string, raw: unknown, ctx: ExpandContext): ServerSpec {
  const r = isRecord(raw) ? raw : {};
  const unresolved: string[] = [];
  const x = (s: unknown) => (typeof s === "string" ? expandVars(s, ctx, unresolved) : undefined);

  const httpUrl = x(r.httpUrl);
  const url = httpUrl ?? x(r.url) ?? x(r.serverUrl);
  const command = x(r.command);
  let transport = transportFromType(r.type) ?? transportFromType(r.transport);
  if (!transport) transport = command ? "stdio" : url ? "http" : "stdio";

  const spec: ServerSpec = { name, transport };
  if (command) spec.command = command;
  if (Array.isArray(r.args)) spec.args = r.args.map((a) => expandVars(String(a), ctx, unresolved));
  const env = stringMap(r.env, ctx, unresolved);
  if (env && Object.keys(env).length) spec.env = env;
  const cwd = x(r.cwd);
  if (cwd) spec.cwd = cwd;
  if (url) spec.url = url;
  const headers = stringMap(r.headers ?? r.http_headers, ctx, unresolved) ?? {};
  if (typeof r.bearer_token_env_var === "string") {
    const tok = ctx.env[r.bearer_token_env_var];
    if (tok) headers.Authorization = `Bearer ${tok}`;
  }
  if (Object.keys(headers).length) spec.headers = headers;
  if (r.disabled === true || r.enabled === false) spec.disabled = true;
  if (unresolved.length) spec.unresolved = [...new Set(unresolved)];
  return spec;
}

/** Normalize a `{ name: rawServer }` map, skipping slimcp's own entry. */
export function normalizeServers(map: unknown, ctx: ExpandContext): ServerSpec[] {
  if (!isRecord(map)) return [];
  return Object.entries(map)
    .filter(([name]) => name.toLowerCase() !== "slimcp")
    .map(([name, raw]) => normalizeServer(name, raw, ctx));
}
