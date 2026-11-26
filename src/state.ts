import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerSpec, UpstreamTool } from "./types.js";

/** slimcp's state directory: $SLIMCP_HOME or ~/.slimcp. */
export function slimcpHome(env: Record<string, string | undefined> = process.env): string {
  return env.SLIMCP_HOME || join(homedir(), ".slimcp");
}

/** Create the state directory with mode 0700. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod is a no-op / may fail on Windows
  }
  return dir;
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (temp file + rename). Mode defaults to 0600: these files can hold secrets. */
export function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
  writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n", mode);
}

export function writeFileAtomic(path: string, content: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // ignore on Windows
  }
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      // Windows: the target may be briefly locked by another reader.
      if (attempt >= 5 || (e as NodeJS.ErrnoException).code !== "EPERM") {
        try {
          unlinkSync(tmp);
        } catch {
          // ignore
        }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

// ---------- tool catalog cache ----------

/** Stable hash of everything that identifies a server's process/endpoint. */
export function specHash(spec: ServerSpec): string {
  const key = JSON.stringify([
    spec.name,
    spec.transport,
    spec.command ?? null,
    spec.args ?? [],
    sortObj(spec.env),
    spec.cwd ?? null,
    spec.url ?? null,
    sortObj(spec.headers),
  ]);
  return createHash("sha256").update(key).digest("hex");
}

function sortObj(o: Record<string, string> | undefined): [string, string][] {
  return Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

interface CatalogFile {
  server: string;
  updatedAt: string;
  tools: UpstreamTool[];
}

function catalogPath(home: string, spec: ServerSpec): string {
  return join(home, "cache", `${specHash(spec).slice(0, 32)}.json`);
}

export function loadCatalog(home: string, spec: ServerSpec): UpstreamTool[] | undefined {
  const f = readJson<CatalogFile | undefined>(catalogPath(home, spec), undefined);
  return Array.isArray(f?.tools) ? f!.tools : undefined;
}

export function saveCatalog(home: string, spec: ServerSpec, tools: UpstreamTool[]): void {
  ensureDir(home);
  ensureDir(join(home, "cache"));
  writeJsonAtomic(catalogPath(home, spec), { server: spec.name, updatedAt: new Date().toISOString(), tools });
}

// ---------- usage stats ----------

export interface UsageEntry {
  calls: number;
  lastUsed: string;
}
export interface UsageFile {
  tools: Record<string, UsageEntry>;
}

export function usagePath(home: string): string {
  return join(home, "usage.json");
}

export function readUsage(home: string): UsageFile {
  const u = readJson<UsageFile>(usagePath(home), { tools: {} });
  return u && typeof u.tools === "object" && u.tools ? u : { tools: {} };
}

/** Tool ids sorted by call count, then recency. */
export function mostUsed(usage: UsageFile): string[] {
  return Object.entries(usage.tools)
    .sort(([, a], [, b]) => b.calls - a.calls || b.lastUsed.localeCompare(a.lastUsed))
    .map(([id]) => id);
}

/** Counts calls in memory and flushes them, debounced, merged with what is on disk. */
export class UsageTracker {
  private pending = new Map<string, UsageEntry>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private home: string,
    private debounceMs = 2000,
  ) {}

  record(id: string): void {
    const cur = this.pending.get(id) ?? { calls: 0, lastUsed: "" };
    cur.calls++;
    cur.lastUsed = new Date().toISOString();
    this.pending.set(id, cur);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return;
    const deltas = this.pending;
    this.pending = new Map();
    try {
      ensureDir(this.home);
      const disk = readUsage(this.home);
      for (const [id, d] of deltas) {
        const cur = disk.tools[id] ?? { calls: 0, lastUsed: "" };
        disk.tools[id] = { calls: cur.calls + d.calls, lastUsed: d.lastUsed > cur.lastUsed ? d.lastUsed : cur.lastUsed };
      }
      writeJsonAtomic(usagePath(this.home), disk);
    } catch {
      // usage stats are best-effort
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
