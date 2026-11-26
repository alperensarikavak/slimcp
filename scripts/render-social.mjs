#!/usr/bin/env node
// Renders scripts/social-preview.html to assets/social-preview.png (1280×640) with headless Chrome/Edge.
// Set CHROME=/path/to/chrome if it is not found automatically.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) throw new Error("No Chrome/Edge found; set CHROME=/path/to/chrome");
const out = join(ROOT, "assets", "social-preview.png");
execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--window-size=1280,640", `--screenshot=${out}`, pathToFileURL(join(ROOT, "scripts", "social-preview.html")).href,
], { stdio: "inherit" });
console.log(`wrote ${out}`);
