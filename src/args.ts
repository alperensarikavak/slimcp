export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Everything after `--`. */
  passthrough: string[];
}

/** Flags that take a value (`--client x` or `--client=x`). */
export const VALUE_FLAGS = new Set(["client", "window", "timeout", "config", "keep", "name", "cwd"]);
const SHORT: Record<string, string> = { h: "help", v: "version", y: "yes" };

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: undefined, positionals: [], flags: {}, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out.passthrough = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) out.flags[key] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) out.flags[key] = argv[++i]!;
      else if (key.startsWith("no-")) out.flags[key.slice(3)] = false;
      else out.flags[key] = true;
      continue;
    }
    if (a.length === 2 && a[0] === "-" && SHORT[a[1]!]) {
      out.flags[SHORT[a[1]!]!] = true;
      continue;
    }
    if (out.command === undefined) out.command = a;
    else out.positionals.push(a);
  }
  return out;
}

export function flagString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function flagList(flags: ParsedArgs["flags"], key: string): string[] | undefined {
  const v = flagString(flags, key);
  return v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const RUNNERS = new Set(["npx", "npx.cmd", "bunx", "pnpx", "uvx", "pipx", "node", "deno", "bun", "python", "python3", "uv", "docker", "cmd", "cmd.exe", "pnpm", "yarn", "npm"]);
const RUNNER_WORDS = new Set(["run", "exec", "dlx", "x", "tool", "-m", "/c", "/C"]);

/**
 * Guess a short server name from a command line:
 * `npx -y @modelcontextprotocol/server-github` → github, `uvx mcp-server-fetch` → fetch,
 * `@playwright/mcp@latest` → playwright.
 */
export function guessName(command: string, args: string[] = []): string {
  const parts = [command, ...args];
  let pkg: string | undefined;
  for (const p of parts) {
    const base = p.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
    if (!pkg && (RUNNERS.has(base) || RUNNERS.has(base.replace(/\.(exe|cmd)$/, "")))) continue;
    if (p.startsWith("-") || RUNNER_WORDS.has(p)) continue;
    pkg = p;
    break;
  }
  if (!pkg) return "server";
  // Strip a version: "@scope/name@1.2" / "name@latest" / "name==1.0".
  let spec = pkg.replace(/==.*$/, "");
  const at = spec.lastIndexOf("@");
  if (at > 0) spec = spec.slice(0, at);
  let scope: string | undefined;
  const scoped = /^@([^/]+)\/(.+)$/.exec(spec);
  let name: string;
  if (scoped) {
    scope = scoped[1];
    name = scoped[2]!;
  } else {
    name = spec.replace(/\\/g, "/").split("/").pop()!;
  }
  name = name.replace(/\.(m?js|cjs|ts|py|exe)$/i, "").toLowerCase().replace(/_/g, "-");
  const stripped = name
    .replace(/^(mcp-server-|server-|mcp-)/, "")
    .replace(/(-mcp-server|-server-mcp|-mcp|-server)$/, "")
    .replace(/[^a-z0-9_-]/g, "-");
  if (!stripped || stripped === "mcp" || stripped === "server") {
    return (scope ?? "server").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  }
  return stripped;
}
