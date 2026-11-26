import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { connect, listAllTools, shortError, type Connection } from "./connect.js";
import {
  buildExposure,
  CALL_TOOL,
  FIND_TOOLS,
  isDestructive,
  renderHits,
  renderServerListing,
  toolId,
  type Exposure,
  type Route,
} from "./expose.js";
import { loadCatalog, mostUsed, readUsage, saveCatalog, slimcpHome, UsageTracker } from "./state.js";
import { countTokens, truncateToTokens } from "./tokens.js";
import type { ResolvedConfig, ServerSpec, UpstreamTool } from "./types.js";
import { VERSION } from "./version.js";

export interface ProxyOptions {
  /** State dir (catalog cache, usage). Defaults to $SLIMCP_HOME or ~/.slimcp. */
  home?: string;
  /** Diagnostic logger. Receives server names, counts and errors — never tool arguments or results. */
  log?: (msg: string) => void;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  usageDebounceMs?: number;
}

interface Upstream {
  spec: ServerSpec;
  conn?: Connection;
  connecting?: Promise<Connection>;
  tools?: UpstreamTool[];
  error?: string;
}

type Args = Record<string, unknown>;

export const INSTRUCTIONS =
  "slimcp keeps most MCP tools behind a search to save context. Before concluding that a capability is " +
  `missing or impossible, call ${FIND_TOOLS} with what you want to do, then run the result with ${CALL_TOOL}.`;

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Cap the text of a tool result at `maxTokens`. Drops structuredContent when it truncates. */
export function capResult(result: CallToolResult, maxTokens: number): CallToolResult {
  if (!maxTokens || !Array.isArray(result.content)) return result;
  const texts = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string");
  // Fast path: a token is at least one UTF-8 byte.
  let bytes = 0;
  for (const t of texts) bytes += Buffer.byteLength(t.text, "utf8");
  if (bytes <= maxTokens) return result;
  const counts = texts.map((t) => countTokens(t.text));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return result;

  let remaining = maxTokens;
  const content: CallToolResult["content"] = [];
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") {
      content.push(item);
      continue;
    }
    if (remaining <= 0) continue;
    const cut = truncateToTokens(item.text, remaining);
    content.push({ ...item, text: cut.text });
    remaining -= cut.tokens;
  }
  content.push({
    type: "text",
    text:
      `[slimcp: output truncated from ${total.toLocaleString("en-US")} to ${maxTokens.toLocaleString("en-US")} tokens ` +
      `to protect the context window — ask for a narrower result (filters, a smaller range, pagination).]`,
  });
  const { structuredContent: _dropped, ...rest } = result;
  return { ...rest, content };
}

export class SlimProxy {
  readonly server: Server;
  readonly home: string;
  private upstreams = new Map<string, Upstream>();
  private exposure!: Exposure;
  private usage: UsageTracker;
  private ready: Promise<void> | undefined;
  private closing = false;
  private initDone = false;
  private log: (msg: string) => void;

  constructor(
    readonly config: ResolvedConfig,
    private opts: ProxyOptions = {},
  ) {
    this.home = opts.home ?? slimcpHome();
    this.log = opts.log ?? (() => {});
    this.usage = new UsageTracker(this.home, opts.usageDebounceMs);
    for (const spec of config.servers) {
      if (spec.disabled) continue;
      this.upstreams.set(spec.name, { spec });
    }
    this.rebuild();
    this.server = new Server(
      { name: "slimcp", version: VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      await this.init();
      return { tools: this.exposure.tools as never };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      await this.init();
      return this.handleCall(req.params.name, (req.params.arguments ?? {}) as Args);
    });
  }

  /**
   * Lazy start: load cached catalogs and connect only to servers that have none
   * (or to all of them with `eager`). Idempotent.
   */
  init(): Promise<void> {
    this.ready ??= (async () => {
      const toConnect: string[] = [];
      for (const [name, u] of this.upstreams) {
        const cached = loadCatalog(this.home, u.spec);
        if (cached) u.tools = cached;
        if (!cached || this.config.options.eager) toConnect.push(name);
      }
      const cachedCount = this.upstreams.size - toConnect.length;
      if (cachedCount) this.log(`${cachedCount} server(s) served from cache`);
      await Promise.allSettled(toConnect.map((n) => this.ensureConnected(n)));
      this.rebuild();
      this.initDone = true;
      const total = [...this.exposure.routes.keys()].length;
      this.log(`${total} tools from ${this.upstreams.size} server(s); exposing ${this.exposure.tools.length}`);
    })();
    return this.ready;
  }

  get currentExposure(): Exposure {
    return this.exposure;
  }

  serverStatus(): { name: string; tools: number; connected: boolean; error?: string }[] {
    return [...this.upstreams.values()].map((u) => ({
      name: u.spec.name,
      tools: u.tools?.length ?? 0,
      connected: !!u.conn,
      ...(u.error ? { error: u.error } : {}),
    }));
  }

  private rebuild(): void {
    const catalogs = new Map<string, UpstreamTool[]>();
    for (const [name, u] of this.upstreams) if (u.tools) catalogs.set(name, u.tools);
    this.exposure = buildExposure(catalogs, this.config.options, mostUsed(readUsage(this.home)));
  }

  /** Connect (once, deduping concurrent callers), refresh and cache the catalog. */
  ensureConnected(name: string): Promise<Connection> {
    const u = this.upstreams.get(name);
    if (!u) return Promise.reject(new Error(`unknown server ${name}`));
    if (u.conn) return Promise.resolve(u.conn);
    if (u.connecting) return u.connecting;
    if (this.closing) return Promise.reject(new Error("slimcp is shutting down"));
    u.connecting = (async () => {
      try {
        const conn = await connect(u.spec, { timeoutMs: this.opts.connectTimeoutMs ?? 120_000 });
        if (this.closing) {
          await conn.close();
          throw new Error("slimcp is shutting down");
        }
        conn.client.onclose = () => {
          if (u.conn === conn) u.conn = undefined;
        };
        conn.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          await this.refresh(name).catch((e) => this.log(`${name}: refresh failed: ${shortError(e)}`));
        });
        u.conn = conn;
        await this.refresh(name);
        this.log(`${name}: connected (${u.tools?.length ?? 0} tools)`);
        return conn;
      } catch (e) {
        u.error = shortError(e);
        this.log(`${name}: ${u.error}`);
        throw e;
      } finally {
        u.connecting = undefined;
      }
    })();
    return u.connecting;
  }

  private async refresh(name: string): Promise<void> {
    const u = this.upstreams.get(name);
    if (!u?.conn) return;
    const tools = await listAllTools(u.conn.client);
    const changed = JSON.stringify(tools) !== JSON.stringify(u.tools);
    u.tools = tools;
    u.error = undefined;
    try {
      saveCatalog(this.home, u.spec, tools);
    } catch (e) {
      this.log(`${name}: could not cache catalog: ${shortError(e)}`);
    }
    if (changed && this.initDone) {
      this.rebuild();
      try {
        // Throws before a client is connected; that is fine.
        await this.server.sendToolListChanged();
      } catch {
        // ignore
      }
    }
  }

  async handleCall(name: string, args: Args): Promise<CallToolResult> {
    try {
      if (name === FIND_TOOLS) return this.findTools(args);
      if (name === CALL_TOOL) return await this.callTool(args);
      const route = this.exposure.routes.get(name);
      if (!route) return this.unknownTool(name);
      if (!this.exposure.pinned.has(name)) {
        const blocked = this.gate(route, false);
        if (blocked) return blocked;
      }
      return await this.forward(route, args);
    } catch (e) {
      return errorResult(`slimcp: ${name} failed: ${shortError(e)}`);
    }
  }

  private findTools(args: Args): CallToolResult {
    const opts = this.config.options;
    const query = typeof args.query === "string" ? args.query : "";
    const server = typeof args.server === "string" && args.server ? args.server : undefined;
    const lim = Number(args.limit);
    const limit = Number.isFinite(lim) && lim > 0 ? Math.min(25, Math.max(1, Math.floor(lim))) : opts.searchLimit;
    const servers = [...this.upstreams.keys()];
    if (server && !this.upstreams.has(server)) {
      return errorResult(`Unknown server "${server}". Servers: ${servers.join(", ")}`);
    }
    const render = { pinned: this.exposure.pinned, minify: opts.minify, gateDestructive: !opts.allowDestructiveViaCallTool };
    if (!query.trim()) {
      if (server) return { content: [{ type: "text", text: renderServerListing(this.exposure.index.all(server), render) }] };
      const lines = servers.map((s) => `- ${s}: ${this.upstreams.get(s)!.tools?.length ?? 0} tools`);
      return { content: [{ type: "text", text: `Give a query, or a server with an empty query to list its tools.\n${lines.join("\n")}` }] };
    }
    const hits = this.exposure.index.search(query, { server, limit });
    let text = hits.length
      ? renderHits(hits, render)
      : `No tools matched "${query}". Try other words, or pass server with an empty query to list a server's tools. Servers: ${servers.join(", ")}`;
    const failed = [...this.upstreams.values()].filter((u) => !u.tools && u.error);
    if (failed.length) text += `\n\nNote: not available right now: ${failed.map((u) => `${u.spec.name} (${u.error})`).join("; ")}`;
    return { content: [{ type: "text", text }] };
  }

  /** Resolve an id, a "server.tool"/"server/tool" spelling, or an unambiguous bare tool name. */
  resolveName(name: string): Route | { error: string } {
    const routes = this.exposure.routes;
    const clean = name.trim().replace(/^mcp__slimcp__/, "");
    const direct = routes.get(clean);
    if (direct) return direct;
    const sep = /^([^./]+)[./](.+)$/.exec(clean);
    if (sep) {
      const r = routes.get(toolId(sep[1]!, sep[2]!));
      if (r) return r;
    }
    const bare = [...routes.values()].filter((r) => r.tool.name === clean);
    if (bare.length === 1) return bare[0]!;
    if (bare.length > 1) return { error: `"${name}" is ambiguous: ${bare.map((r) => r.id).join(", ")}. Use the full id.` };
    return { error: this.didYouMean(name) };
  }

  private didYouMean(name: string): string {
    const near = this.exposure.index.closest(name).map((d) => d.id);
    return `Unknown tool "${name}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""} Use ${FIND_TOOLS} to search.`;
  }

  private unknownTool(name: string): CallToolResult {
    return errorResult(this.didYouMean(name));
  }

  private async callTool(args: Args): Promise<CallToolResult> {
    const name = args.name;
    if (typeof name !== "string" || !name) return errorResult(`${CALL_TOOL} needs "name" (a tool id from ${FIND_TOOLS}).`);
    let toolArgs: unknown = args.arguments ?? {};
    if (typeof toolArgs === "string") {
      try {
        toolArgs = toolArgs.trim() ? JSON.parse(toolArgs) : {};
      } catch {
        return errorResult(`"arguments" must be an object or a JSON string; could not parse it.`);
      }
    }
    if (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs)) {
      return errorResult(`"arguments" must be an object.`);
    }
    const route = this.resolveName(name);
    if ("error" in route) return errorResult(route.error);
    const blocked = this.gate(route, true);
    if (blocked) return blocked;
    return await this.forward(route, toolArgs as Args);
  }

  /** The destructive-tool gate: destructive tools only run under their own (pinned) name. */
  private gate(route: Route, viaCallTool: boolean): CallToolResult | undefined {
    if (this.config.options.allowDestructiveViaCallTool || !isDestructive(route.tool)) return undefined;
    if (this.exposure.pinned.has(route.id)) {
      if (!viaCallTool) return undefined;
      return errorResult(`${route.id} is destructive and pinned: call it directly as ${route.id} so your client can ask for approval.`);
    }
    const where = this.config.path ? ` in ${this.config.path}` : "";
    return errorResult(
      `slimcp blocked ${route.id}: the server marks it destructive, and running it through ${CALL_TOOL} would skip ` +
        `your client's per-tool approval. To use it, pin it${where}: "pin": ["auto", "${route.id}"]. ` +
        `It then shows up as its own tool and your client asks before each call. Tell the user this.`,
    );
  }

  private async forward(route: Route, args: Args): Promise<CallToolResult> {
    const conn = await this.ensureConnected(route.server);
    this.usage.record(route.id);
    const res = (await conn.client.callTool({ name: route.tool.name, arguments: args }, undefined, {
      timeout: this.opts.callTimeoutMs ?? 600_000,
      resetTimeoutOnProgress: true,
    })) as CallToolResult;
    return capResult(res, this.config.options.maxResultTokens);
  }

  /** Close every upstream connection (no orphaned children) and flush usage stats. */
  async close(): Promise<void> {
    this.closing = true;
    this.usage.flush();
    const pending = [...this.upstreams.values()].map(async (u) => {
      const c = u.conn ?? (await u.connecting?.catch(() => undefined));
      u.conn = undefined;
      await c?.close();
    });
    await Promise.allSettled(pending);
  }
}

/** Run slimcp as a stdio MCP server until the client goes away. */
export async function runStdioProxy(config: ResolvedConfig, opts: ProxyOptions = {}): Promise<SlimProxy> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[slimcp] ${m}\n`));
  const proxy = new SlimProxy(config, { ...opts, log });
  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${why})`);
    const force = setTimeout(() => process.exit(0), 6000);
    force.unref();
    try {
      await proxy.close();
      await proxy.server.close().catch(() => {});
    } finally {
      process.exit(0);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
  process.stdin.on("end", () => void shutdown("stdin ended"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  proxy.server.onclose = () => void shutdown("transport closed");
  process.on("unhandledRejection", (e) => log(`unhandled: ${shortError(e)}`));

  await proxy.server.connect(new StdioServerTransport());
  void proxy.init().catch((e) => log(`init failed: ${shortError(e)}`));
  return proxy;
}
