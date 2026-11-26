import { createHash } from "node:crypto";
import { minifySchema, minifyTool } from "./minify.js";
import { SearchIndex, type SearchDoc, type SearchHit } from "./search.js";
import type { SlimOptions, UpstreamTool } from "./types.js";

export const FIND_TOOLS = "find_tools";
export const CALL_TOOL = "call_tool";
const MAX_ID = 64;

/** `server__tool`, restricted to [A-Za-z0-9_-] and at most 64 characters. */
export function toolId(server: string, tool: string): string {
  const raw = `${server}__${tool}`;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (clean.length <= MAX_ID) return clean;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${clean.slice(0, MAX_ID - hash.length - 1)}_${hash}`;
}

export interface Route {
  id: string;
  server: string;
  tool: UpstreamTool;
}

export interface ToolDoc extends SearchDoc {
  route: Route;
}

/** A tool definition as sent to the client. */
export interface ExposedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface Exposure {
  tools: ExposedTool[];
  routes: Map<string, Route>;
  pinned: Set<string>;
  hiddenCount: number;
  index: SearchIndex<ToolDoc>;
}

export function isDestructive(tool: UpstreamTool): boolean {
  return tool.annotations?.destructiveHint === true && tool.annotations?.readOnlyHint !== true;
}

/** Ids matched by pin patterns. "auto" adds the `autoPin` most-used ids that still exist. */
export function resolvePins(ids: string[], patterns: string[], autoPin: number, mostUsed: string[] = []): Set<string> {
  const known = new Set(ids);
  const out = new Set<string>();
  for (const p of patterns) {
    if (p === "auto") {
      let n = 0;
      for (const id of mostUsed) {
        if (n >= autoPin) break;
        if (known.has(id)) {
          out.add(id);
          n++;
        }
      }
    } else if (p.endsWith("*")) {
      const prefix = p.slice(0, -1);
      for (const id of ids) if (id.startsWith(prefix)) out.add(id);
    } else if (known.has(p)) {
      out.add(p);
    }
  }
  return out;
}

export function buildExposure(
  catalogs: Map<string, UpstreamTool[]> | Record<string, UpstreamTool[]>,
  cfg: SlimOptions,
  mostUsed: string[] = [],
): Exposure {
  const entries = catalogs instanceof Map ? [...catalogs.entries()] : Object.entries(catalogs);
  const routes = new Map<string, Route>();
  for (const [server, tools] of entries) {
    for (const tool of tools) {
      let id = toolId(server, tool.name);
      for (let i = 2; routes.has(id); i++) id = toolId(server, `${tool.name}_${i}`);
      routes.set(id, { id, server, tool });
    }
  }
  const ids = [...routes.keys()];
  const pinned = resolvePins(ids, cfg.pin, cfg.autoPin, mostUsed);
  const docs: ToolDoc[] = [...routes.values()].map((r) => ({
    id: r.id,
    server: r.server,
    name: r.tool.name,
    description: r.tool.description,
    inputSchema: r.tool.inputSchema,
    route: r,
  }));
  const index = new SearchIndex(docs);

  const tools: ExposedTool[] = [];
  for (const id of pinned) {
    const r = routes.get(id)!;
    const m = minifyTool(r.tool, cfg.minify);
    const t: ExposedTool = { name: id, inputSchema: m.inputSchema };
    if (m.description !== undefined) t.description = m.description;
    if (r.tool.annotations) t.annotations = { ...r.tool.annotations };
    tools.push(t);
  }

  const hidden = [...routes.values()].filter((r) => !pinned.has(r.id));
  if (hidden.length > 0) tools.push(findToolsDef(hidden, cfg), callToolDef());
  return { tools, routes, pinned, hiddenCount: hidden.length, index };
}

function findToolsDef(hidden: Route[], cfg: SlimOptions): ExposedTool {
  const byServer = new Map<string, string[]>();
  for (const r of hidden) byServer.set(r.server, [...(byServer.get(r.server) ?? []), r.tool.name]);
  const servers = [...byServer.keys()];
  let catalog: string;
  if (cfg.catalog === "servers") {
    catalog = servers.map((s) => `${s} (${byServer.get(s)!.length})`).join(", ");
  } else {
    catalog = servers.map((s) => `${s}: ${byServer.get(s)!.join(", ")}`).join("\n");
  }
  const description =
    `Search ${hidden.length} more tools from ${servers.length} MCP server${servers.length === 1 ? "" : "s"} ` +
    `and get their input schemas. Call this BEFORE saying something is impossible or a tool is missing. ` +
    `Then run a result with ${CALL_TOOL}.\n${catalog}`;
  return {
    name: FIND_TOOLS,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, in plain words (e.g. \"open a pull request\")." },
        server: { type: "string", enum: servers, description: "Only search this server." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: `Max results (default ${cfg.searchLimit}).` },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  };
}

function callToolDef(): ExposedTool {
  return {
    name: CALL_TOOL,
    description: `Run a tool found with ${FIND_TOOLS}. Pass its id as name and its arguments as an object.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool id from find_tools, e.g. github__create_issue." },
        arguments: { type: "object", description: "Arguments matching the tool's schema." },
      },
      required: ["name"],
    },
  };
}

export interface RenderOptions {
  pinned: Set<string>;
  minify: SlimOptions["minify"];
  gateDestructive: boolean;
}

function compactSchema(schema: Record<string, unknown>, level: SlimOptions["minify"]): string {
  return JSON.stringify(minifySchema(schema ?? { type: "object" }, level));
}

/** Text returned by find_tools. */
export function renderHits(hits: SearchHit<ToolDoc>[], opts: RenderOptions): string {
  if (!hits.length) return "No matching tools.";
  return hits
    .map(({ doc }) => {
      const r = doc.route;
      const notes: string[] = [];
      if (opts.pinned.has(r.id)) notes.push(`pinned — call it directly as ${r.id}`);
      else if (opts.gateDestructive && isDestructive(r.tool)) notes.push("destructive — pin to use");
      const head = `### ${r.id}${notes.length ? ` (${notes.join("; ")})` : ""}`;
      const desc = minifyTool(r.tool, opts.minify).description ?? "";
      return `${head}\n${desc}\nschema: ${compactSchema(r.tool.inputSchema, opts.minify)}`;
    })
    .join("\n\n");
}

/** find_tools with an empty query and a server: every tool of that server, one line each. */
export function renderServerListing(docs: ToolDoc[], opts: RenderOptions): string {
  if (!docs.length) return "No tools on that server.";
  return docs
    .map((d) => {
      const one = minifyTool(d.route.tool, "aggressive").description ?? "";
      const mark = opts.gateDestructive && isDestructive(d.route.tool) && !opts.pinned.has(d.id) ? " (destructive — pin to use)" : "";
      return `- ${d.id}${mark}: ${one}`;
    })
    .join("\n");
}
