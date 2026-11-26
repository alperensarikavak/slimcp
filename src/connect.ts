import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerSpec, UpstreamTool } from "./types.js";
import { VERSION } from "./version.js";

export interface ConnectOptions {
  timeoutMs?: number;
  /** Where the child's stderr goes. "pipe" (default) captures the last lines for error messages. */
  stderr?: "pipe" | "inherit" | "ignore";
}

export interface Connection {
  name: string;
  client: Client;
  /** Last captured stderr lines of a stdio child. */
  stderrTail(): string;
  close(): Promise<void>;
}

const TAIL_LINES = 20;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** process.env minus undefined values, plus the server's own env. */
export function childEnv(spec: ServerSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...(spec.env ?? {}) };
}

/** Windows only: kill a whole process tree (`npx` runs through cmd.exe; killing cmd alone orphans node). */
function killTree(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    // already gone
  }
}

function makeClient(): Client {
  return new Client({ name: "slimcp", version: VERSION }, { capabilities: {} });
}

/** Connect to one upstream MCP server. Rejects with stderr context on failure or timeout. */
export async function connect(spec: ServerSpec, opts: ConnectOptions = {}): Promise<Connection> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  if (spec.unresolved?.length) {
    throw new Error(`unresolved placeholder ${spec.unresolved.join(", ")} (only the client that owns it can fill it in)`);
  }

  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error("no command configured");
    const tail: string[] = [];
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: childEnv(spec),
      cwd: spec.cwd,
      stderr: opts.stderr ?? "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line.length > 300 ? line.slice(0, 300) + "…" : line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    });
    const client = makeClient();
    const stderrTail = () => tail.slice(-5).join("\n");
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      // POSIX: the SDK ends stdin, then SIGTERM/SIGKILLs the child (npx forwards signals).
      // Windows: npx runs via cmd.exe, so kill the whole tree first or node is orphaned.
      if (process.platform === "win32") killTree(transport.pid);
      await client.close().catch(() => {});
    };
    try {
      await withTimeout(client.connect(transport), timeoutMs, "connect");
    } catch (e) {
      await close();
      throw decorate(e, spec, stderrTail());
    }
    return { name: spec.name, client, stderrTail, close };
  }

  if (!spec.url) throw new Error("no url configured");
  const url = new URL(spec.url);
  const requestInit: RequestInit = spec.headers ? { headers: spec.headers } : {};
  const attempt = async (transport: Transport): Promise<Connection> => {
    const client = makeClient();
    try {
      await withTimeout(client.connect(transport), timeoutMs, "connect");
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    return { name: spec.name, client, stderrTail: () => "", close: () => client.close().catch(() => {}) };
  };
  if (spec.transport === "sse") {
    try {
      return await attempt(new SSEClientTransport(url, { requestInit }));
    } catch (e) {
      throw decorate(e, spec, "");
    }
  }
  try {
    return await attempt(new StreamableHTTPClientTransport(url, { requestInit }));
  } catch (first) {
    if (first instanceof TimeoutError) throw decorate(first, spec, "");
    try {
      return await attempt(new SSEClientTransport(url, { requestInit }));
    } catch {
      throw decorate(first, spec, "");
    }
  }
}

function decorate(e: unknown, spec: ServerSpec, stderr: string): Error {
  const err = e as NodeJS.ErrnoException;
  let msg = err?.message ?? String(e);
  if (err?.code === "ENOENT" && spec.command) msg = `command not found: ${spec.command}`;
  if (/Connection closed/i.test(msg) && stderr) {
    // Windows runs commands through cmd.exe, so a missing binary shows up on stderr instead of ENOENT.
    const lastLine = stderr.split("\n").pop()!.trim();
    msg = /is not recognized as an internal or external command/i.test(stderr) && spec.command
      ? `command not found: ${spec.command}`
      : `server exited during startup: ${lastLine.length > 160 ? lastLine.slice(0, 160) + "…" : lastLine}`;
  }
  const out = new Error(stderr ? `${msg}\n  stderr: ${stderr.replace(/\n/g, "\n          ")}` : msg);
  (out as Error & { short?: string }).short = msg;
  return out;
}

/** The first line of an error, for one-line reports. */
export function shortError(e: unknown): string {
  const err = e as Error & { short?: string };
  return (err?.short ?? err?.message ?? String(e)).split("\n")[0]!;
}

/** tools/list, following nextCursor pagination. */
export async function listAllTools(client: Client, timeoutMs = 45_000): Promise<UpstreamTool[]> {
  const tools: UpstreamTool[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    for (const t of res.tools) tools.push(t as UpstreamTool);
    cursor = res.nextCursor;
    if (cursor && seen.has(cursor)) break; // defensive: a server repeating its cursor
    if (cursor) seen.add(cursor);
  } while (cursor);
  return tools;
}
