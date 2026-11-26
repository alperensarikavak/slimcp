import { DEFAULT_OPTIONS } from "./config.js";
import { connect, listAllTools, shortError } from "./connect.js";
import { claudeCodeToolSearch, defaultContext, discoverSources, type DiscoverContext, type ToolSearchStatus } from "./discover.js";
import { buildExposure } from "./expose.js";
import { loadCatalog, saveCatalog, slimcpHome, specHash } from "./state.js";
import { toolTokens } from "./tokens.js";
import type { ConfigSource, ServerSpec, UpstreamTool } from "./types.js";

export const DEFAULT_WINDOW = 200_000;

export interface AuditOptions {
  ctx?: DiscoverContext;
  home?: string;
  /** Offline: use cached catalogs only, never start servers. */
  cached?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  /** Only these client ids. */
  clients?: string[];
  windowTokens?: number;
  onProgress?: (msg: string) => void;
}

export interface ServerResult {
  spec: ServerSpec;
  tools?: UpstreamTool[];
  tokens: number;
  error?: string;
  fromCache?: boolean;
}

export interface ServerRow {
  name: string;
  scope: string;
  tools: number;
  tokens: number;
  error?: string;
  disabled?: boolean;
}

export interface ClientReport {
  id: string;
  name: string;
  paths: string[];
  native?: string;
  /** Claude Code only: whether built-in tool search is on, and why. */
  toolSearch?: ToolSearchStatus;
  servers: ServerRow[];
  totalTools: number;
  totalTokens: number;
  /** Estimated tokens with slimcp in front (default settings). */
  slimTokens: number;
  pct: number;
  grade: Grade;
  errors: string[];
}

export interface HeavyTool {
  id: string;
  server: string;
  tokens: number;
}

export interface AuditResult {
  windowTokens: number;
  clients: ClientReport[];
  heaviest: HeavyTool[];
}

export type Grade = "A" | "B" | "C" | "D" | "F";

/** A <2%, B <5%, C <10%, D <20% of the window, otherwise F. */
export function grade(pct: number): Grade {
  if (pct < 2) return "A";
  if (pct < 5) return "B";
  if (pct < 10) return "C";
  if (pct < 20) return "D";
  return "F";
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** Connect to one server, list its tools and cache them. */
export async function inspectServer(spec: ServerSpec, home: string, timeoutMs: number): Promise<ServerResult> {
  let conn;
  try {
    conn = await connect(spec, { timeoutMs });
    const tools = await listAllTools(conn.client, timeoutMs);
    try {
      saveCatalog(home, spec, tools);
    } catch {
      // cache is best-effort
    }
    return { spec, tools, tokens: tools.reduce((a, t) => a + toolTokens(t), 0) };
  } catch (e) {
    return { spec, tokens: 0, error: shortError(e) };
  } finally {
    await conn?.close();
  }
}

export async function runAudit(opts: AuditOptions = {}): Promise<AuditResult> {
  const ctx = opts.ctx ?? defaultContext();
  const home = opts.home ?? slimcpHome(ctx.env);
  const windowTokens = opts.windowTokens ?? DEFAULT_WINDOW;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const sources = discoverSources(ctx, opts.clients);

  // De-duplicate identical servers across clients: inspect each once.
  const unique = new Map<string, ServerSpec>();
  for (const src of sources) for (const s of src.servers) if (!s.disabled) unique.set(specHash(s), s);

  const results = new Map<string, ServerResult>();
  const todo: [string, ServerSpec][] = [];
  for (const [key, spec] of unique) {
    if (spec.unresolved?.length) {
      results.set(key, { spec, tokens: 0, error: `needs ${spec.unresolved.join(", ")} from the client` });
      continue;
    }
    const cached = loadCatalog(home, spec);
    if (opts.cached) {
      results.set(
        key,
        cached
          ? { spec, tools: cached, tokens: cached.reduce((a, t) => a + toolTokens(t), 0), fromCache: true }
          : { spec, tokens: 0, error: "not cached yet (run without --cached)" },
      );
      continue;
    }
    todo.push([key, spec]);
  }
  let done = 0;
  await pool(todo, opts.concurrency ?? 6, async ([key, spec]) => {
    const r = await inspectServer(spec, home, timeoutMs);
    results.set(key, r);
    opts.onProgress?.(`${++done}/${todo.length} ${spec.name}${r.error ? " ✗" : ` (${r.tools!.length} tools)`}`);
  });

  // Group sources per client.
  const byClient = new Map<string, ConfigSource[]>();
  for (const s of sources) byClient.set(s.clientId, [...(byClient.get(s.clientId) ?? []), s]);

  const clients: ClientReport[] = [];
  for (const [id, srcs] of byClient) {
    const first = srcs[0]!;
    const rows: ServerRow[] = [];
    const catalogs = new Map<string, UpstreamTool[]>();
    for (const src of srcs) {
      for (const spec of src.servers) {
        if (spec.disabled) {
          rows.push({ name: spec.name, scope: src.scope, tools: 0, tokens: 0, disabled: true });
          continue;
        }
        const r = results.get(specHash(spec))!;
        rows.push({ name: spec.name, scope: src.scope, tools: r.tools?.length ?? 0, tokens: r.tokens, ...(r.error ? { error: r.error } : {}) });
        if (r.tools) {
          let key = spec.name;
          for (let i = 2; catalogs.has(key); i++) key = `${spec.name}${i}`;
          catalogs.set(key, r.tools);
        }
      }
    }
    const totalTokens = rows.reduce((a, r) => a + r.tokens, 0);
    const totalTools = rows.reduce((a, r) => a + r.tools, 0);
    const slim = buildExposure(catalogs, DEFAULT_OPTIONS, []);
    const slimTokens = catalogs.size ? slim.tools.reduce((a, t) => a + toolTokens(t), 0) : 0;
    const pct = (totalTokens / windowTokens) * 100;
    clients.push({
      id,
      name: first.clientName,
      paths: [...new Set(srcs.map((s) => s.path))],
      ...(first.native ? { native: first.native } : {}),
      ...(id === "claude-code" ? { toolSearch: claudeCodeToolSearch(ctx.env) } : {}),
      servers: rows.sort((a, b) => b.tokens - a.tokens),
      totalTools,
      totalTokens,
      slimTokens,
      pct,
      grade: grade(pct),
      errors: srcs.filter((s) => s.error).map((s) => s.error!),
    });
  }
  clients.sort((a, b) => Number(!!a.native) - Number(!!b.native) || b.totalTokens - a.totalTokens);

  const heavy: HeavyTool[] = [];
  for (const r of results.values()) {
    for (const t of r.tools ?? []) heavy.push({ id: `${r.spec.name}__${t.name}`, server: r.spec.name, tokens: toolTokens(t) });
  }
  heavy.sort((a, b) => b.tokens - a.tokens);
  return { windowTokens, clients, heaviest: heavy.slice(0, 5) };
}
