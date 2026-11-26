import { describe, expect, it } from "vitest";
import { firstSentence, minifySchema, minifyTool } from "../src/minify.js";

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "x",
  $comment: "internal",
  title: "Args",
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", title: "Title", description: "The   issue\n title.  More detail here." },
    description: { type: "string", description: "A parameter literally named description." },
    readOnly: { type: "boolean", readOnly: true },
    tags: { type: "array", items: { type: "string", title: "Tag", examples: ["a"] } },
    mode: { type: "string", enum: ["title", "examples"], default: "title", deprecated: true },
    meta: { type: "object", default: { title: "kept: default values are data" } },
  },
  $defs: { title: { type: "string", title: "Def" } },
  required: ["title", "description"],
  examples: [{ title: "x" }],
};

describe("minifySchema", () => {
  it("off returns the schema untouched", () => {
    expect(minifySchema(schema, "off")).toBe(schema);
  });

  it("safe drops noise keys but keeps parameters named title/description/readOnly", () => {
    const m = minifySchema(schema, "safe") as any;
    expect(m.$schema).toBeUndefined();
    expect(m.$id).toBeUndefined();
    expect(m.$comment).toBeUndefined();
    expect(m.title).toBeUndefined();
    expect(Object.keys(m.properties)).toEqual(["title", "description", "readOnly", "tags", "mode", "meta"]);
    expect(m.properties.title).toEqual({ type: "string", description: "The issue title. More detail here." });
    expect(m.properties.readOnly).toEqual({ type: "boolean" });
    expect(m.properties.tags.items.title).toBeUndefined();
    expect(m.properties.mode).toEqual({ type: "string", enum: ["title", "examples"], default: "title" });
    expect(m.properties.meta.default).toEqual({ title: "kept: default values are data" });
    expect(m.$defs.title).toEqual({ type: "string" });
    expect(m.required).toEqual(["title", "description"]);
    // safe keeps examples and additionalProperties
    expect(m.examples).toBeDefined();
    expect(m.additionalProperties).toBe(false);
  });

  it("aggressive also drops examples and additionalProperties:false and shortens descriptions", () => {
    const m = minifySchema(schema, "aggressive") as any;
    expect(m.examples).toBeUndefined();
    expect(m.additionalProperties).toBeUndefined();
    expect(m.properties.tags.items.examples).toBeUndefined();
    expect(m.properties.title.description).toBe("The issue title.");
    expect(m.properties.title.type).toBe("string");
  });

  it("keeps additionalProperties schemas (not false) in aggressive mode", () => {
    const m = minifySchema({ type: "object", additionalProperties: { type: "string", title: "x" } }, "aggressive") as any;
    expect(m.additionalProperties).toEqual({ type: "string" });
  });
});

describe("descriptions", () => {
  it("firstSentence takes the first paragraph's first sentence and caps length", () => {
    expect(firstSentence("Create an issue. Then more.\n\nArgs: x", 240)).toBe("Create an issue.");
    expect(firstSentence("Use e.g. the API to fetch. Next.", 240)).toBe("Use e.g. the API to fetch.");
    expect(firstSentence("No period here\n\nArgs: x", 240)).toBe("No period here");
    expect(firstSentence("x".repeat(300), 240)).toHaveLength(240);
  });

  it("minifyTool shortens the tool description by level", () => {
    const t = { name: "t", description: "First sentence.  Second sentence.\n\nMore.", inputSchema: { type: "object" } };
    expect(minifyTool(t, "safe").description).toBe("First sentence. Second sentence. More.");
    expect(minifyTool(t, "aggressive").description).toBe("First sentence.");
    expect(minifyTool(t, "off")).toBe(t);
  });
});
