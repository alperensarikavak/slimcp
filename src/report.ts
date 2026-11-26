import type { AuditResult, ClientReport, Grade } from "./audit.js";

export interface ReportOptions {
  color?: boolean;
  home?: string;
}

/** Colors on for TTYs unless NO_COLOR is set; FORCE_COLOR forces them on. */
export function useColor(stream: NodeJS.WriteStream = process.stdout, env = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pctStr = (p: number) => (p < 10 ? p.toFixed(1) : Math.round(p).toString());

function painter(on: boolean) {
  const wrap = (open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

function gradeColor(g: Grade, c: ReturnType<typeof painter>): (s: string) => string {
  return g === "A" || g === "B" ? c.green : g === "C" ? c.yellow : c.red;
}

function tilde(p: string, home?: string): string {
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) return "~" + p.slice(home.length).replace(/\\/g, "/");
  return p.replace(/\\/g, "/");
}

function bar(value: number, max: number, width = 20): string {
  const full = max > 0 ? Math.round((value / max) * width) : 0;
  const n = value > 0 ? Math.max(1, full) : 0;
  return "█".repeat(n) + "░".repeat(width - n);
}

function windowLabel(w: number): string {
  return w >= 1000 ? `${Math.round(w / 1000)}K` : String(w);
}

/** True when the client sends every tool definition up front. */
export function paysFullPrice(c: ClientReport): boolean {
  return !c.native;
}

export function shareLine(result: AuditResult): string | undefined {
  const worst = result.clients.find((c) => paysFullPrice(c) && c.totalTokens > 0);
  if (!worst) return undefined;
  return (
    `My MCP servers eat ${fmt(worst.totalTokens)} tokens (${pctStr(worst.pct)}% of the context window) ` +
    `before I type a word — grade ${worst.grade}. Check yours: npx slimcp audit`
  );
}

export function renderReport(result: AuditResult, opts: ReportOptions = {}): string {
  const c = painter(!!opts.color);
  const out: string[] = [];
  const w = windowLabel(result.windowTokens);
  out.push(c.bold("slimcp audit") + c.dim(` — what your MCP tool definitions cost on every request (o200k tokens, ${w} window)`));
  out.push("");
  if (!result.clients.length) {
    out.push("No MCP servers found in Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI or Codex configs.");
    return out.join("\n");
  }
  const maxTokens = Math.max(1, ...result.clients.flatMap((cl) => cl.servers.map((s) => s.tokens)));
  const nameW = Math.min(28, Math.max(6, ...result.clients.flatMap((cl) => cl.servers.map((s) => s.name.length))));

  for (const cl of result.clients) {
    out.push(`${c.bold(c.cyan(cl.name))}  ${c.dim(cl.paths.map((p) => tilde(p, opts.home)).join(", "))}`);
    if (cl.toolSearch && !cl.toolSearch.enabled) {
      out.push(`  ${c.yellow("⚠ tool search is OFF")} ${c.dim("— " + cl.toolSearch.reason + "; every tool loads up front")}`);
    }
    for (const err of cl.errors) out.push(`  ${c.red("✗")} ${err}`);
    for (const s of cl.servers) {
      const name = s.name.length > nameW ? s.name.slice(0, nameW - 1) + "…" : s.name.padEnd(nameW);
      if (s.disabled) {
        out.push(`  ${c.dim(`· ${name}  disabled`)}`);
      } else if (s.error) {
        out.push(`  ${c.red("✗")} ${name}  ${c.red(s.error)}`);
      } else {
        const tools = `${s.tools} tools`.padStart(9);
        const tok = fmt(s.tokens).padStart(7);
        out.push(`    ${name}  ${tools}  ${tok}  ${c.magenta(bar(s.tokens, maxTokens))}`);
      }
    }
    if (cl.native) {
      out.push(`  ${c.green("✓")} ${cl.native} ${c.dim("— not paid up front")}`);
    } else if (cl.totalTokens === 0 && cl.servers.some((s) => s.error)) {
      out.push(`  ${c.yellow("no server could be measured")} ${c.dim("— fix the ✗ rows above and run again")}`);
    } else {
      const g = gradeColor(cl.grade, c);
      out.push(
        `  ${c.bold(`${fmt(cl.totalTools)} tools · ${fmt(cl.totalTokens)} tokens · ${pctStr(cl.pct)}% of a ${w} window`)} ` +
          `${c.dim("— sent with every request")}   grade ${g(c.bold(cl.grade))}`,
      );
      if (cl.totalTokens > 0 && cl.slimTokens < cl.totalTokens) {
        const saved = cl.totalTokens - cl.slimTokens;
        out.push(
          `  ${c.green(`with slimcp ≈ ${fmt(cl.slimTokens)} tokens → saves ${fmt(saved)} (−${Math.round((saved / cl.totalTokens) * 100)}%)`)}`,
        );
      }
    }
    out.push("");
  }

  if (result.heaviest.length) {
    out.push(c.bold("Heaviest tools"));
    const idW = Math.max(...result.heaviest.map((h) => h.id.length));
    for (const h of result.heaviest) out.push(`  ${h.id.padEnd(idW)}  ${fmt(h.tokens).padStart(6)}`);
    out.push("");
  }
  if (result.clients.some((cl) => paysFullPrice(cl) && cl.totalTokens > 0)) {
    out.push(`${c.bold("Fix it:")} ${c.cyan("npx slimcp init")}  ${c.dim("(dry run; nothing changes until --yes)")}`);
  }
  const share = shareLine(result);
  if (share) out.push(`${c.bold("Share:")} ${share}`);
  return out.join("\n");
}

function badge(label: string, message: string, color: string): string {
  const esc = (s: string) => encodeURIComponent(s.replace(/-/g, "--").replace(/_/g, "__"));
  return `https://img.shields.io/badge/${esc(label)}-${esc(message)}-${color}`;
}

const BADGE_COLOR: Record<Grade, string> = { A: "brightgreen", B: "green", C: "yellow", D: "orange", F: "red" };

export function renderMarkdown(result: AuditResult): string {
  const w = windowLabel(result.windowTokens);
  const lines = ["## MCP context audit (slimcp)", ""];
  for (const cl of result.clients) {
    const msg = cl.native ? "deferred natively" : `${fmt(cl.totalTokens)} tokens · grade ${cl.grade}`;
    const color = cl.native ? "blue" : BADGE_COLOR[cl.grade];
    lines.push(`![${cl.name}: ${msg}](${badge(cl.name, msg, color)})`);
  }
  lines.push("", `| Client | Servers | Tools | Tokens / request | % of ${w} | Grade | With slimcp |`, "|---|---:|---:|---:|---:|:-:|---:|");
  for (const cl of result.clients) {
    const ok = cl.servers.filter((s) => !s.error && !s.disabled).length;
    lines.push(
      `| ${cl.name} | ${ok} | ${fmt(cl.totalTools)} | ${fmt(cl.totalTokens)} | ${pctStr(cl.pct)}% | ${cl.native ? "native" : cl.grade} | ${
        cl.native ? "—" : `${fmt(cl.slimTokens)}`
      } |`,
    );
  }
  for (const cl of result.clients) {
    lines.push("", `### ${cl.name}`, "", "| Server | Tools | Tokens |", "|---|---:|---:|");
    for (const s of cl.servers) {
      lines.push(`| ${s.name} | ${s.error ? "✗" : s.disabled ? "disabled" : s.tools} | ${s.error ? s.error.replace(/\|/g, "\\|") : fmt(s.tokens)} |`);
    }
  }
  const share = shareLine(result);
  lines.push("", `_Generated by [slimcp](https://github.com/alperensarikavak/slimcp): \`npx slimcp audit --markdown\`_`);
  if (share) lines.push("", `> ${share}`);
  return lines.join("\n");
}

export function renderJson(result: AuditResult): string {
  return JSON.stringify(result, null, 2);
}
