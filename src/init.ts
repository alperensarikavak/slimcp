import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultContext, discoverSources, findClient, getAtPath, parseConfigText, type DiscoverContext } from "./discover.js";
import { ensureDir, readJson, slimcpHome, writeFileAtomic, writeJsonAtomic } from "./state.js";
import type { ConfigSource } from "./types.js";
import { VERSION } from "./version.js";

export interface InitOptions {
  ctx?: DiscoverContext;
  home?: string;
  /** Only these clients. Naming a client also includes it when it defers tools natively. */
  clients?: string[];
  /** Server names to leave where they are. */
  keep?: string[];
  /** Include project-scoped configs (e.g. ./.mcp.json, ./.vscode/mcp.json). */
  project?: boolean;
  /** Name of the entry slimcp adds. */
  name?: string;
  version?: string;
}

export interface PlannedChange {
  source: ConfigSource;
  move: string[];
  keep: { name: string; reason: string }[];
  slimConfigPath: string;
  entryName: string;
  entry: Record<string, unknown>;
}

export interface SkippedSource {
  client: string;
  path: string;
  scope: string;
  reason: string;
}

export interface ManualStep {
  client: string;
  path: string;
  move: string[];
  slimConfigPath: string;
  servers: Record<string, unknown>;
  snippet: string;
}

export interface InitPlan {
  home: string;
  changes: PlannedChange[];
  skipped: SkippedSource[];
  manual: ManualStep[];
  warnings: string[];
}

export interface BackupRecord {
  file: string;
  backup: string;
  createdAt: string;
}

/** The command a client runs to start slimcp. Always pinned to an exact version, never @latest. */
export function slimcpEntry(clientId: string, platform: NodeJS.Platform, configPath: string, version = VERSION): Record<string, unknown> {
  const npxArgs = ["-y", `slimcp@${version}`, "serve", "--config", configPath];
  const base = platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...npxArgs] } : { command: "npx", args: npxArgs };
  return clientId === "vscode" ? { type: "stdio", ...base } : base;
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function codexSnippet(name: string, entry: Record<string, unknown>): string {
  const args = (entry.args as string[]).map(tomlString).join(", ");
  return `[mcp_servers.${name}]\ncommand = ${tomlString(entry.command as string)}\nargs = [${args}]`;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

export function planInit(opts: InitOptions = {}): InitPlan {
  const ctx = opts.ctx ?? defaultContext();
  const home = opts.home ?? slimcpHome(ctx.env);
  const explicit = opts.clients?.map((c) => findClient(c)?.id ?? c);
  const keepSet = new Set(opts.keep ?? []);
  const entryName = opts.name ?? "slimcp";
  const plan: InitPlan = { home, changes: [], skipped: [], manual: [], warnings: [] };

  for (const src of discoverSources(ctx, explicit)) {
    const skip = (reason: string) => plan.skipped.push({ client: src.clientName, path: src.path, scope: src.scope, reason });
    if (src.error) {
      skip(src.error);
      continue;
    }
    if (src.native && !explicit?.includes(src.clientId)) {
      skip(`${src.native}; pass --client ${src.clientId} to wrap it anyway`);
      continue;
    }
    if (src.scope === "local") {
      skip("Claude Code local (per-project private) scope is left alone");
      continue;
    }
    if (src.scope === "project" && !opts.project) {
      skip("project config (pass --project to include it)");
      continue;
    }
    const move: string[] = [];
    const keep: { name: string; reason: string }[] = [];
    for (const s of src.servers) {
      if (keepSet.has(s.name)) keep.push({ name: s.name, reason: "--keep" });
      else if (s.disabled) keep.push({ name: s.name, reason: "disabled" });
      else if (s.unresolved?.length) keep.push({ name: s.name, reason: `uses ${s.unresolved.join(", ")}` });
      else move.push(s.name);
    }
    if (!move.length) {
      skip("nothing to move");
      continue;
    }
    const suffix = src.scope === "project" ? `-${shortHash(src.path)}` : "";
    const slimConfigPath = join(home, `${src.clientId}-${src.scope}${suffix}.json`);
    const entry = slimcpEntry(src.clientId, ctx.platform, slimConfigPath, opts.version);
    if (src.format === "toml") {
      const servers = Object.fromEntries(move.map((n) => [n, src.raw[n]]));
      plan.manual.push({
        client: src.clientName,
        path: src.path,
        move,
        slimConfigPath,
        servers,
        snippet: codexSnippet(entryName, entry),
      });
      continue;
    }
    plan.changes.push({ source: src, move, keep, slimConfigPath, entryName, entry });
  }

  if (plan.changes.some((c) => c.source.clientId === "claude-code")) {
    plan.warnings.push("Quit Claude Code before applying: it rewrites ~/.claude.json while running and could undo the change.");
  }
  for (const c of plan.changes) {
    if (c.source.format === "jsonc") {
      plan.warnings.push(`Comments in ${c.source.path} will be lost (it is rewritten as plain JSON). The backup keeps them.`);
    }
  }
  return plan;
}

function backupsPath(home: string): string {
  return join(home, "backups.json");
}

export function readBackups(home: string): BackupRecord[] {
  const b = readJson<{ backups?: BackupRecord[] }>(backupsPath(home), {});
  return Array.isArray(b.backups) ? b.backups : [];
}

function chmod600(p: string): void {
  try {
    chmodSync(p, 0o600);
  } catch {
    // ignore on Windows
  }
}

/** Merge moved servers into a slimcp config file (created with mode 0600). */
function mergeSlimConfig(path: string, servers: Record<string, unknown>): void {
  const existing = readJson<Record<string, unknown>>(path, {});
  const prev = { ...((existing.mcpServers as object) ?? {}), ...((existing.servers as object) ?? {}) };
  const { mcpServers: _old, ...rest } = existing;
  writeJsonAtomic(path, { ...rest, servers: { ...prev, ...servers } }, 0o600);
}

export interface ApplyResult {
  files: { file: string; backup: string; moved: string[]; slimConfigPath: string }[];
  manual: ManualStep[];
}

/** Apply a plan: back up each file, move servers into ~/.slimcp, put a single slimcp entry in their place. */
export function applyInit(plan: InitPlan, now = new Date()): ApplyResult {
  ensureDir(plan.home);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const result: ApplyResult = { files: [], manual: plan.manual };
  const backups = readBackups(plan.home);

  const byFile = new Map<string, PlannedChange[]>();
  for (const c of plan.changes) byFile.set(c.source.path, [...(byFile.get(c.source.path) ?? []), c]);

  for (const [file, changes] of byFile) {
    const original = readFileSync(file);
    const backup = `${file}.slimcp-backup-${stamp}`;
    writeFileSync(backup, original, { mode: 0o600 });
    chmod600(backup);
    backups.push({ file, backup, createdAt: now.toISOString() });
    writeJsonAtomic(backupsPath(plan.home), { backups });

    const parsed = parseConfigText(original.toString("utf8"), changes[0]!.source.format) as Record<string, unknown>;
    for (const c of changes) {
      const map = getAtPath(parsed, c.source.keyPath) as Record<string, unknown>;
      const moved: Record<string, unknown> = {};
      for (const name of c.move) {
        moved[name] = map[name];
        delete map[name];
      }
      mergeSlimConfig(c.slimConfigPath, moved);
      map[c.entryName] = c.entry;
      result.files.push({ file, backup, moved: c.move, slimConfigPath: c.slimConfigPath });
    }
    let mode = 0o644;
    try {
      mode = statSync(file).mode & 0o777;
    } catch {
      // keep default
    }
    writeFileAtomic(file, JSON.stringify(parsed, null, 2) + "\n", mode);
  }

  // TOML clients: write the slimcp config; the user pastes the snippet themselves.
  for (const m of plan.manual) mergeSlimConfig(m.slimConfigPath, m.servers);
  return result;
}

export interface RestoreResult {
  restored: { file: string; backup: string }[];
  missing: BackupRecord[];
}

/** Copy back the OLDEST backup of each file slimcp changed. */
export function restore(home = slimcpHome()): RestoreResult {
  const all = readBackups(home);
  const oldest = new Map<string, BackupRecord>();
  for (const b of all) {
    const cur = oldest.get(b.file);
    if (!cur || b.createdAt < cur.createdAt) oldest.set(b.file, b);
  }
  const result: RestoreResult = { restored: [], missing: [] };
  const done = new Set<string>();
  for (const b of oldest.values()) {
    if (!existsSync(b.backup)) {
      result.missing.push(b);
      continue;
    }
    copyFileSync(b.backup, b.file);
    result.restored.push({ file: b.file, backup: b.backup });
    done.add(b.file);
  }
  if (all.length) writeJsonAtomic(backupsPath(home), { backups: all.filter((b) => !done.has(b.file)) });
  return result;
}

export function renderPlan(plan: InitPlan, applied: boolean): string {
  const out: string[] = [];
  if (!plan.changes.length && !plan.manual.length) {
    out.push("Nothing to change.");
  }
  for (const c of plan.changes) {
    out.push(`${c.source.clientName} (${c.source.scope})  ${c.source.path}`);
    out.push(`  move → ${c.slimConfigPath}: ${c.move.join(", ")}`);
    for (const k of c.keep) out.push(`  keep: ${k.name} (${k.reason})`);
    out.push(`  add "${c.entryName}": ${c.entry.command} ${(c.entry.args as string[]).join(" ")}`);
    out.push("");
  }
  for (const m of plan.manual) {
    out.push(`${m.client}  ${m.path}  (TOML: edit by hand)`);
    out.push(`  ${applied ? "wrote" : "will write"} ${m.slimConfigPath} with: ${m.move.join(", ")}`);
    out.push(`  then remove those [mcp_servers.*] tables and add:`);
    out.push(m.snippet.replace(/^/gm, "    "));
    out.push("");
  }
  for (const s of plan.skipped) out.push(`skip ${s.client} (${s.scope}) ${s.path}: ${s.reason}`);
  if (plan.skipped.length) out.push("");
  for (const w of plan.warnings) out.push(`⚠ ${w}`);
  if (!applied && (plan.changes.length || plan.manual.length)) {
    out.push("", "Dry run — nothing changed. Apply with: npx slimcp init --yes   (undo any time: npx slimcp restore)");
  } else if (applied) {
    out.push("", "Done. Restart your MCP clients. Undo any time: npx slimcp restore");
  }
  return out.join("\n").trimEnd();
}
