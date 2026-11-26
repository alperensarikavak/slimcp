import type { MinifyLevel, UpstreamTool } from "./types.js";

/** Schema keywords that carry no meaning for a model calling the tool. */
const SAFE_NOISE = new Set(["$schema", "$id", "$comment", "title", "deprecated", "readOnly", "writeOnly"]);
const AGGRESSIVE_NOISE = new Set(["examples", "example"]);

/** Keywords whose value is a map of name → schema. Keys inside are parameter names, never noise. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Keywords whose value is a single schema. */
const SCHEMA_VALUES = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);
/** Keywords whose value is an array of schemas. */
const SCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

export const TOOL_DESC_MAX = 240;
export const PARAM_DESC_MAX = 120;

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** First sentence of the first paragraph, capped at `max` characters. */
export function firstSentence(s: string, max: number): string {
  const para = s.trim().split(/\n\s*\n/)[0] ?? "";
  const flat = collapseWhitespace(para);
  // A sentence ends at . ! ? followed by whitespace + a capital/quote/paren, or end of text.
  const m = /^(.+?[.!?])(?=\s+[A-Z("'`[]|\s*$)/.exec(flat);
  let out = m ? m[1]! : flat;
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + "…";
  return out;
}

export function minifyDescription(desc: string | undefined, level: MinifyLevel, max: number): string | undefined {
  if (desc === undefined || level === "off") return desc;
  if (level === "safe") return collapseWhitespace(desc);
  return firstSentence(desc, max);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minify a JSON schema. Only schema-valued keywords are recursed into; enum/default/const values are copied verbatim. */
export function minifySchema<T>(schema: T, level: MinifyLevel): T {
  if (level === "off") return schema;
  return walkSchema(schema, level) as T;
}

function walkSchema(node: unknown, level: MinifyLevel): unknown {
  if (Array.isArray(node)) return node.map((n) => walkSchema(n, level));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (SAFE_NOISE.has(key)) continue;
    if (level === "aggressive") {
      if (AGGRESSIVE_NOISE.has(key)) continue;
      if (key === "additionalProperties" && value === false) continue;
    }
    if (key === "description" && typeof value === "string") {
      out[key] = minifyDescription(value, level, PARAM_DESC_MAX);
    } else if (SCHEMA_MAPS.has(key) && isRecord(value)) {
      const map: Record<string, unknown> = {};
      for (const [param, sub] of Object.entries(value)) map[param] = walkSchema(sub, level);
      out[key] = map;
    } else if (SCHEMA_VALUES.has(key) && (isRecord(value) || Array.isArray(value))) {
      out[key] = walkSchema(value, level);
    } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(value)) {
      out[key] = value.map((v) => walkSchema(v, level));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Minify a tool definition (description + input schema). Other fields are kept. */
export function minifyTool<T extends Pick<UpstreamTool, "description" | "inputSchema">>(tool: T, level: MinifyLevel): T {
  if (level === "off") return tool;
  const out = { ...tool, inputSchema: minifySchema(tool.inputSchema ?? { type: "object" }, level) };
  const d = minifyDescription(tool.description, level, TOOL_DESC_MAX);
  if (d !== undefined) out.description = d;
  return out;
}
