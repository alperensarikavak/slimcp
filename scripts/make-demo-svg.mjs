#!/usr/bin/env node
// Builds assets/demo.svg: an animated terminal showing real `npx slimcp audit` output
// (captured with scripts/demo-audit.mjs). Each line is [segments], segment = [text, color?].
import { writeFileSync } from "node:fs";

const C = { fg: "#e6edf3", dim: "#7d8590", cyan: "#39c5cf", green: "#3fb950", red: "#f85149", mag: "#d2a8ff", yellow: "#d29922" };
const L = [
  [["❯ ", C.green], ["npx slimcp audit"]],
  [],
  [["slimcp audit", C.fg, true], [" — what your MCP tool definitions cost on every request (o200k tokens, 200K window)", C.dim]],
  [],
  [["Claude Desktop", C.cyan, true], ["  ~/Library/Application Support/Claude/claude_desktop_config.json", C.dim]],
  [["    notion       24 tools   17,140  "], ["████████████████████", C.mag]],
  [["    playwright   25 tools    3,921  "], ["█████░░░░░░░░░░░░░░░", C.mag]],
  [["    github       26 tools    3,546  "], ["████░░░░░░░░░░░░░░░░", C.mag]],
  [["    filesystem   14 tools    1,678  "], ["██░░░░░░░░░░░░░░░░░░", C.mag]],
  [["    memory        9 tools      947  "], ["█░░░░░░░░░░░░░░░░░░░", C.mag]],
  [["  98 tools · 27,232 tokens · 14% of a 200K window", C.fg, true], [" — sent with every request", C.dim], ["   grade "], ["D", C.red, true]],
  [["  with slimcp ≈ 734 tokens → saves 26,498 (−97%)", C.green]],
  [],
  [["Heaviest tools", C.fg, true]],
  [["  notion__API-update-page-markdown   1,267"]],
  [["  notion__API-post-search            1,083"]],
  [["  notion__API-patch-page               875"]],
  [],
  [["Fix it:", C.fg, true], [" "], ["npx slimcp init", C.cyan], ["  (dry run; nothing changes until --yes)", C.dim]],
  [["Share:", C.fg, true], [" My MCP servers eat 27,232 tokens (14% of the context window) before I"]],
  [["       type a word — grade D. Check yours: npx slimcp audit"]],
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 900, LH = 20, TOP = 62;
const H = TOP + L.length * LH + 22;
const lines = L.map((segs, i) => {
  const delay = i === 0 ? 0.2 : 0.9 + i * 0.12;
  const spans = segs
    .map(([t, color, bold]) => `<tspan${color ? ` fill="${color}"` : ""}${bold ? ' font-weight="700"' : ""}>${esc(t)}</tspan>`)
    .join("");
  return `  <text class="l" x="20" y="${TOP + i * LH}" style="animation-delay:${delay.toFixed(2)}s" xml:space="preserve">${spans}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terminal running npx slimcp audit: Claude Desktop with notion, playwright, github, filesystem and memory MCP servers sends 98 tools and 27,232 tokens with every request, 14% of a 200K context window, grade D. With slimcp it is about 734 tokens, a 97% saving.">
  <title>npx slimcp audit — 27,232 tokens of MCP tools per request, grade D; with slimcp ≈ 734 (−97%)</title>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 13px; fill: ${C.fg}; }
    .l { opacity: 0; animation: in .35s ease-out forwards; }
    @keyframes in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .l { animation: none; opacity: 1; } }
  </style>
  <rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="#30363d"/>
  <circle cx="22" cy="20" r="6" fill="#ff5f57"/>
  <circle cx="42" cy="20" r="6" fill="#febc2e"/>
  <circle cx="62" cy="20" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="24" text-anchor="middle" style="fill:${C.dim};font-size:12px">slimcp — zsh</text>
${lines.join("\n")}
</svg>
`;
writeFileSync(new URL("../assets/demo.svg", import.meta.url), svg);
console.log(`wrote assets/demo.svg (${W}x${H})`);
