import { describe, expect, it } from "vitest";
import { SearchIndex, stem, tokenize, type SearchDoc } from "../src/search.js";

describe("tokenizer", () => {
  it("splits camelCase and snake_case, lowercases and removes stopwords", () => {
    expect(tokenize("createPullRequest")).toEqual(["creat", "pull", "request"]);
    expect(tokenize("list_open_issues")).toEqual(["list", "open", "issu"]);
    expect(tokenize("Get the HTMLParser of a page")).toEqual(["get", "html", "parser", "page"]);
  });

  it("stems so inflections match", () => {
    expect(stem("creating")).toBe(stem("create"));
    expect(stem("issues")).toBe(stem("issue"));
    expect(stem("repositories")).toBe(stem("repository"));
    expect(stem("branches")).toBe(stem("branch"));
    expect(stem("updated")).toBe(stem("update"));
    expect(stem("files")).toBe(stem("file"));
    expect(stem("removing")).toBe(stem("remove"));
  });
});

const doc = (server: string, name: string, description: string, props: Record<string, string> = {}): SearchDoc => ({
  id: `${server}__${name}`,
  server,
  name,
  description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: "string", description: d }])),
  },
});

const DOCS = [
  doc("github", "create_issue", "Create a new issue in a repository", { title: "Issue title", body: "Issue body" }),
  doc("github", "delete_label", "Delete a label from a repository"),
  doc("github", "create_pull_request", "Open a new pull request", { head: "Branch with changes", base: "Target branch" }),
  doc("github", "list_issues", "List issues in a repository"),
  doc("github", "search_code", "Search code across repositories"),
  doc("filesystem", "read_file", "Read the complete contents of a file", { path: "Path to the file" }),
  doc("filesystem", "list_directory", "List files and folders in a directory", { path: "Directory path" }),
  doc("filesystem", "write_file", "Write content to a file, overwriting it", { path: "Path", content: "Content" }),
  doc("playwright", "browser_navigate", "Navigate to a URL", { url: "The URL to navigate to" }),
  doc("playwright", "browser_take_screenshot", "Take a screenshot of the current page"),
  doc("memory", "create_entities", "Create multiple new entities in the knowledge graph"),
];

describe("SearchIndex", () => {
  const index = new SearchIndex(DOCS);
  const top = (q: string, server?: string) => index.search(q, { server, limit: 3 })[0]?.doc.id;

  it("ranks by intent, including synonyms", () => {
    expect(top("remove a label")).toBe("github__delete_label");
    expect(top("open a PR")).toBe("github__create_pull_request");
    expect(top("show me what is in this folder")).toBe("filesystem__list_directory");
    expect(top("go to a website url")).toBe("playwright__browser_navigate");
    expect(top("capture an image of the page")).toBe("playwright__browser_take_screenshot");
    expect(top("file a bug report issue")).toBe("github__create_issue");
    expect(top("fetch the contents of a document")).toBe("filesystem__read_file");
  });

  it("gives an exact name match a large bonus", () => {
    expect(top("list_issues")).toBe("github__list_issues");
    expect(top("github__search_code")).toBe("github__search_code");
  });

  it("filters by server", () => {
    const hits = index.search("create", { server: "memory", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.doc.server === "memory")).toBe(true);
  });

  it("returns nothing for unrelated queries", () => {
    expect(index.search("zzzqqq", { limit: 5 })).toEqual([]);
  });

  it("suggests close names for typos", () => {
    expect(index.closest("github__create_isue")[0]!.id).toBe("github__create_issue");
    expect(index.closest("list_directry")[0]!.id).toBe("filesystem__list_directory");
  });
});
