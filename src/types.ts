/** How slimcp talks to an upstream MCP server. */
export type TransportKind = "stdio" | "http" | "sse";

/** A normalized MCP server definition, whatever client config it came from. */
export interface ServerSpec {
  name: string;
  transport: TransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** `disabled: true` or `enabled: false` in the source config. */
  disabled?: boolean;
  /** Placeholders slimcp cannot resolve on its own, e.g. VS Code `${input:token}`. */
  unresolved?: string[];
}

export type ConfigFormat = "json" | "jsonc" | "toml";
export type ConfigScope = "user" | "project" | "local";

/** One block of MCP servers found inside one client config file. */
export interface ConfigSource {
  clientId: string;
  clientName: string;
  scope: ConfigScope;
  path: string;
  /** Path of keys inside the file that holds the server map, e.g. ["projects", "/repo", "mcpServers"]. */
  keyPath: string[];
  format: ConfigFormat;
  servers: ServerSpec[];
  /** The raw (un-normalized) server objects, keyed by name. */
  raw: Record<string, unknown>;
  /** Set when the client already defers MCP tools natively. */
  native?: string;
  /** Parse/read error, if any. */
  error?: string;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/** A tool as reported by an upstream server's tools/list. */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export type MinifyLevel = "off" | "safe" | "aggressive";
export type CatalogMode = "names" | "servers";

/** User-facing options of a slimcp proxy config file. */
export interface SlimOptions {
  /** Tool ids or patterns exposed directly: exact id, `server__*`, `prefix*`, or "auto". */
  pin: string[];
  /** How many most-used tools "auto" pins. */
  autoPin: number;
  minify: MinifyLevel;
  /** Cap on text returned by a single tool call. 0 disables the cap. */
  maxResultTokens: number;
  /** Default number of find_tools hits. */
  searchLimit: number;
  /** What find_tools' description lists: every hidden tool name, or only server names. */
  catalog: CatalogMode;
  /** Connect to every server at startup instead of using cached catalogs. */
  eager: boolean;
  /** Let call_tool run tools annotated as destructive. Off by default. */
  allowDestructiveViaCallTool: boolean;
}

/** Raw shape of `~/.slimcp/<name>.json`. */
export interface SlimConfig extends Partial<SlimOptions> {
  servers?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
}

export interface ResolvedConfig {
  path?: string;
  servers: ServerSpec[];
  options: SlimOptions;
}
