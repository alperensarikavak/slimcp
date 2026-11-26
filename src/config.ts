import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { normalizeServers, parseJsonc } from "./normalize.js";
import type { ResolvedConfig, SlimConfig, SlimOptions } from "./types.js";

export const DEFAULT_OPTIONS: SlimOptions = {
  pin: ["auto"],
  autoPin: 5,
  minify: "safe",
  maxResultTokens: 12_000,
  searchLimit: 5,
  catalog: "names",
  eager: false,
  allowDestructiveViaCallTool: false,
};

const OptionsSchema = z.object({
  pin: z.array(z.string()).optional(),
  autoPin: z.number().int().min(0).max(100).optional(),
  minify: z.enum(["off", "safe", "aggressive"]).optional(),
  maxResultTokens: z.number().int().min(0).optional(),
  searchLimit: z.number().int().min(1).max(25).optional(),
  catalog: z.enum(["names", "servers"]).optional(),
  eager: z.boolean().optional(),
  allowDestructiveViaCallTool: z.boolean().optional(),
});

export function resolveOptions(raw: Partial<SlimOptions> = {}): SlimOptions {
  const parsed = OptionsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`invalid option "${issue.path.join(".")}": ${issue.message}`);
  }
  const out: SlimOptions = { ...DEFAULT_OPTIONS };
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

export interface LoadContext {
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
}

/** Build a resolved config from an in-memory object (accepts `servers` or `mcpServers`). */
export function resolveConfig(raw: SlimConfig, ctx: LoadContext = {}, path?: string): ResolvedConfig {
  const { servers, mcpServers, ...opts } = raw ?? {};
  const map = { ...(mcpServers ?? {}), ...(servers ?? {}) };
  const specs = normalizeServers(map, { env: ctx.env ?? process.env, home: ctx.home ?? homedir(), cwd: ctx.cwd ?? process.cwd() });
  const known = new Set(Object.keys(OptionsSchema.shape));
  const options = resolveOptions(Object.fromEntries(Object.entries(opts).filter(([k]) => known.has(k))) as Partial<SlimOptions>);
  return { ...(path ? { path } : {}), servers: specs, options };
}

/** Load a slimcp config file (JSON or JSONC). */
export function loadConfig(path: string, ctx: LoadContext = {}): ResolvedConfig {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    throw new Error(`cannot read config ${abs}: ${(e as Error).message}`);
  }
  let raw: SlimConfig;
  try {
    raw = parseJsonc(text) as SlimConfig;
  } catch (e) {
    throw new Error(`cannot parse config ${abs}: ${(e as Error).message}`);
  }
  return resolveConfig(raw, ctx, abs);
}
