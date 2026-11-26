/*
 * A small dependency-free BM25 index over tool definitions.
 * No embeddings, no network: queries are matched on words, with light
 * stemming and a hand-written synonym table for common tool verbs/nouns.
 */

const STOPWORDS = new Set(
  (
    "a an the of to in on for and or with by from at as is are be been was were it its this that these those " +
    "me my i you your we our us they them can could will would should please some any into via if when then " +
    "which what how do does did so just also using use want need like"
  ).split(" "),
);

/** Stem in sequence: ies→y; strip -ing / -ed / -es (after ss,x,ch,sh) / -s; then a trailing e on long words. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Split camelCase / snake_case / kebab-case, lowercase, drop stopwords, stem. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  const out: string[] = [];
  for (const raw of spaced.split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

const SYNONYM_GROUPS: string[][] = [
  ["delete", "remove", "erase", "drop"],
  ["create", "add", "new", "make", "open", "insert", "write", "post"],
  ["get", "fetch", "retrieve", "read", "show", "view", "load", "download"],
  ["list", "show", "browse"],
  ["update", "edit", "modify", "change", "patch", "rename", "set"],
  ["search", "find", "lookup", "query"],
  ["run", "execute", "invoke", "start"],
  ["send", "post", "message", "notify"],
  ["screenshot", "capture", "snapshot", "image"],
  ["navigate", "goto", "visit", "url"],
  ["pr", "pull", "merge"],
  ["repo", "repository", "project"],
  ["file", "document", "doc"],
  ["directory", "folder", "dir"],
];

/** stemmed term → stemmed synonyms */
const SYNONYMS: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const stems = group.map(stem);
    for (const s of stems) {
      const set = m.get(s) ?? new Set<string>();
      for (const o of stems) if (o !== s) set.add(o);
      m.set(s, set);
    }
  }
  return m;
})();

export const SYNONYM_WEIGHT = 0.5;
const K1 = 1.2;
const B = 0.75;

export interface SearchDoc {
  id: string;
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface SearchHit<D extends SearchDoc = SearchDoc> {
  doc: D;
  score: number;
}

interface Indexed<D> {
  doc: D;
  tf: Map<string, number>;
  len: number;
}

function paramText(schema: unknown, depth = 0): string[] {
  if (depth > 4 || typeof schema !== "object" || schema === null) return [];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  const props = s.properties;
  if (props && typeof props === "object") {
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      out.push(name);
      const d = (sub as Record<string, unknown> | null)?.description;
      if (typeof d === "string") out.push(d);
      out.push(...paramText(sub, depth + 1));
    }
  }
  if (s.items) out.push(...paramText(s.items, depth + 1));
  return out;
}

export class SearchIndex<D extends SearchDoc = SearchDoc> {
  private docs: Indexed<D>[] = [];
  private df = new Map<string, number>();
  private avgdl = 1;

  constructor(docs: D[] = []) {
    for (const d of docs) this.add(d);
    this.finish();
  }

  get size(): number {
    return this.docs.length;
  }

  private add(doc: D): void {
    const tf = new Map<string, number>();
    const bump = (terms: string[], w: number) => {
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + w);
    };
    bump(tokenize(doc.name), 3);
    bump(tokenize(doc.server), 2);
    bump(tokenize(doc.description ?? ""), 1);
    bump(tokenize(paramText(doc.inputSchema).join(" ")), 1);
    let len = 0;
    for (const v of tf.values()) len += v;
    this.docs.push({ doc, tf, len });
  }

  private finish(): void {
    let total = 0;
    for (const d of this.docs) {
      total += d.len;
      for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgdl = this.docs.length ? total / this.docs.length || 1 : 1;
  }

  /** Query terms with weights: the query's own words at 1, synonyms at 0.5. */
  static expand(query: string): Map<string, number> {
    const terms = new Map<string, number>();
    for (const t of tokenize(query)) terms.set(t, 1);
    for (const t of [...terms.keys()]) {
      for (const syn of SYNONYMS.get(t) ?? []) {
        if (!terms.has(syn)) terms.set(syn, SYNONYM_WEIGHT);
      }
    }
    return terms;
  }

  search(query: string, opts: { server?: string; limit?: number } = {}): SearchHit<D>[] {
    const limit = opts.limit ?? 5;
    const terms = SearchIndex.expand(query);
    const q = query.trim().toLowerCase();
    const qn = q.replace(/[\s-]+/g, "_");
    const N = this.docs.length;
    const hits: SearchHit<D>[] = [];
    for (const d of this.docs) {
      if (opts.server && d.doc.server !== opts.server) continue;
      let score = 0;
      for (const [t, w] of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += w * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / this.avgdl)));
      }
      const name = d.doc.name.toLowerCase();
      const id = d.doc.id.toLowerCase();
      if (qn && (qn === name || qn === id)) score += 100;
      else if (qn.length >= 3 && (name.includes(qn) || (name.length >= 4 && q.includes(name)))) score += 5;
      if (score > 0) hits.push({ doc: d.doc, score });
    }
    hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
    return hits.slice(0, limit);
  }

  /** Closest ids/names to a (mistyped) tool name, by character-trigram similarity. */
  closest(name: string, limit = 3): D[] {
    const target = trigrams(name);
    const scored = this.docs
      .map((d) => {
        const s = Math.max(similarity(target, trigrams(d.doc.id)), similarity(target, trigrams(d.doc.name)));
        return { doc: d.doc, s };
      })
      .filter((x) => x.s >= 0.3)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.doc);
  }

  all(server?: string): D[] {
    return this.docs.map((d) => d.doc).filter((d) => !server || d.server === server);
  }
}

function trigrams(s: string): Set<string> {
  const t = `  ${s.toLowerCase()} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Dice coefficient of two trigram sets. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}
