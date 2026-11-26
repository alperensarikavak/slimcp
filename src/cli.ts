#!/usr/bin/env node
import { flagList, flagString, guessName, parseArgs } from "./args.js";
import { DEFAULT_WINDOW, runAudit } from "./audit.js";
import { DEFAULT_OPTIONS, loadConfig, resolveConfig } from "./config.js";
import { defaultContext } from "./discover.js";
import { applyInit, planInit, renderPlan, restore } from "./init.js";
import { runStdioProxy } from "./proxy.js";
import { renderJson, renderMarkdown, renderReport, useColor } from "./report.js";
import { mostUsed, readUsage, slimcpHome } from "./state.js";
import { VERSION } from "./version.js";

const HELP = `slimcp ${VERSION} — cut MCP tool token usage by 90%+

Usage: npx slimcp <command> [options]

Commands
  audit                 Show how many tokens your MCP tools cost in each client (read-only)
      --client a,b        only these clients (claude-code, claude-desktop, cursor, vscode, windsurf, gemini, codex)
      --cached            offline: use cached tool lists, start no servers
      --window N          context window to compare against (default 200000; accepts 128k, 1m)
      --timeout S         seconds to wait per server (default 45)
      --cwd DIR           project directory for project-scoped configs
      --markdown | --json other output formats
  init                  Put slimcp in front of your servers (dry run unless --yes)
      --yes               apply the changes (backups are made first)
      --client a,b        only these clients (also wraps clients that defer tools natively)
      --keep a,b          leave these servers alone
      --project           include project configs (.mcp.json, .vscode/mcp.json, ...)
      --name NAME         name of the slimcp entry (default "slimcp")
  restore               Undo init: copy back the oldest backup of every changed file
  serve --config FILE   Run the proxy over stdio (this is what your client launches)
  wrap [--name N] -- <command...>
                        Proxy a single server given on the command line
  stats                 Most-used tools (the top ${DEFAULT_OPTIONS.autoPin} are auto-pinned)
  help, --version

Examples
  npx slimcp audit
  npx slimcp init            # preview
  npx slimcp init --yes      # apply
  npx slimcp wrap -- npx -y @modelcontextprotocol/server-github

slimcp runs locally and makes no network requests of its own. Docs: https://github.com/alperensarikavak/slimcp`;

function parseWindow(v: string | undefined): number {
  if (!v) return DEFAULT_WINDOW;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(v.trim());
  if (!m) throw new Error(`--window: expected a number like 200000, 128k or 1m, got "${v}"`);
  const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1000 : 1;
  return Math.round(Number(m[1]) * mult);
}

function out(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const f = args.flags;
  if (f.version && !args.command) return out(VERSION);
  const cmd = args.command ?? (f.help ? "help" : "help");
  const ctx = defaultContext(flagString(f, "cwd") ? { cwd: flagString(f, "cwd")! } : {});

  switch (cmd) {
    case "help":
      return out(HELP);

    case "audit": {
      const timeout = Number(flagString(f, "timeout") ?? 45);
      const showProgress = !f.json && !f.markdown && process.stderr.isTTY;
      const result = await runAudit({
        ctx,
        cached: !!f.cached,
        clients: flagList(f, "client"),
        windowTokens: parseWindow(flagString(f, "window")),
        timeoutMs: Math.max(1, timeout) * 1000,
        onProgress: showProgress ? (m) => process.stderr.write(`\r\x1b[2K  checking ${m}`) : undefined,
      });
      if (showProgress) process.stderr.write("\r\x1b[2K");
      if (f.json) return out(renderJson(result));
      if (f.markdown) return out(renderMarkdown(result));
      return out(renderReport(result, { color: useColor(), home: ctx.home }));
    }

    case "init": {
      const plan = planInit({
        ctx,
        clients: flagList(f, "client"),
        keep: flagList(f, "keep"),
        project: !!f.project,
        name: flagString(f, "name"),
      });
      if (f.yes) {
        applyInit(plan);
        return out(renderPlan(plan, true));
      }
      return out(renderPlan(plan, false));
    }

    case "restore": {
      const r = restore(slimcpHome());
      if (!r.restored.length && !r.missing.length) return out("No backups to restore.");
      for (const x of r.restored) out(`restored ${x.file}  ← ${x.backup}`);
      for (const m of r.missing) out(`missing backup ${m.backup} for ${m.file}`);
      return out("Restart your MCP clients to pick up the original config.");
    }

    case "serve": {
      const path = flagString(f, "config") ?? args.positionals[0];
      if (!path) throw new Error("serve needs --config <file>");
      await runStdioProxy(loadConfig(path));
      return;
    }

    case "wrap": {
      const [command, ...rest] = args.passthrough;
      if (!command) throw new Error("usage: slimcp wrap [--name N] -- <command> [args...]");
      const name = flagString(f, "name") ?? guessName(command, rest);
      await runStdioProxy(resolveConfig({ servers: { [name]: { command, args: rest } } }));
      return;
    }

    case "stats": {
      const usage = readUsage(slimcpHome());
      const ids = mostUsed(usage);
      if (!ids.length) return out("No tool calls recorded yet. Usage is counted locally when tools run through slimcp.");
      const w = Math.max(...ids.slice(0, 30).map((i) => i.length));
      out(`Most-used tools (local stats, ${slimcpHome()})\n`);
      ids.slice(0, 30).forEach((id, i) => {
        const e = usage.tools[id]!;
        const star = i < DEFAULT_OPTIONS.autoPin ? "★" : " ";
        out(`${star} ${id.padEnd(w)}  ${String(e.calls).padStart(6)} calls  last ${e.lastUsed.slice(0, 10)}`);
      });
      return out(`\n★ = auto-pinned with "pin": ["auto"] (top ${DEFAULT_OPTIONS.autoPin}; change with "autoPin")`);
    }

    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}\n`);
      process.exitCode = 1;
  }
}

// Called unconditionally: npx runs this file through a .bin symlink, so argv[1] checks are unreliable.
main().catch((e: Error) => {
  process.stderr.write(`slimcp: ${e?.message ?? e}\n`);
  process.exit(1);
});
