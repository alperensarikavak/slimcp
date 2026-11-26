import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";
import type { UpstreamTool } from "./types.js";

/*
 * Token counts use OpenAI's o200k_base encoding as a neutral yardstick.
 * Claude, Gemini and local models tokenize differently, and each client wraps
 * tool definitions in its own framing, so absolute numbers are approximate.
 * What matters is the relative saving, which holds across tokenizers.
 */

let encoder: Tiktoken | undefined;
function enc(): Tiktoken {
  encoder ??= new Tiktoken(o200k_base);
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return enc().encode(text, [], []).length;
}

/** Tokens a tool definition costs on every request. */
export function toolTokens(tool: Pick<UpstreamTool, "name" | "description" | "inputSchema">): number {
  return countTokens(
    JSON.stringify({ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema ?? {} }),
  );
}

export interface Truncated {
  text: string;
  tokens: number;
  originalTokens: number;
  truncated: boolean;
}

/** Cut text down to at most `max` tokens. */
export function truncateToTokens(text: string, max: number): Truncated {
  const ids = enc().encode(text, [], []);
  if (ids.length <= max) return { text, tokens: ids.length, originalTokens: ids.length, truncated: false };
  const cut = enc().decode(ids.slice(0, Math.max(0, max)));
  return { text: cut, tokens: max, originalTokens: ids.length, truncated: true };
}
