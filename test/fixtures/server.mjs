#!/usr/bin/env node
// A fake stdio MCP server with 42 deliberately verbose, GitHub-like tools
// (6 verbs × 7 nouns). Used by the e2e tests; never talks to the network.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VERBS = {
  create: "Create a new",
  get: "Get the full details of a single",
  list: "List every",
  update: "Update the fields of an existing",
  delete: "Permanently delete a",
  search: "Search across all repositories for a",
};
const NOUNS = {
  issue: "issue",
  pull_request: "pull request",
  repository: "repository",
  branch: "branch",
  release: "release",
  label: "label",
  milestone: "milestone",
};

function makeTool(verb, noun) {
  const human = NOUNS[noun];
  const name = `${verb}_${noun}`;
  const description =
    `${VERBS[verb]} ${human} in a GitHub repository. ` +
    `This tool talks to the GitHub REST API on behalf of the authenticated user and returns the raw JSON response.\n\n` +
    `Use it whenever the user asks to ${verb.replace("_", " ")} a ${human}. ` +
    `The owner and repo parameters are required for every call; pagination parameters apply to list and search operations.\n\n` +
    `Args:\n  owner: the account that owns the repository\n  repo: the repository name\n` +
    `Returns: the ${human} object(s) exactly as GitHub returns them, including URLs, timestamps and author details.`;
  const properties = {
    owner: {
      type: "string",
      title: "Owner",
      description: "Repository owner: the user or organization login that owns the repository, for example 'octocat'.",
      examples: ["octocat", "modelcontextprotocol"],
    },
    repo: {
      type: "string",
      title: "Repository",
      description: "Repository name without the owner prefix, for example 'hello-world'. Case-insensitive.",
      examples: ["hello-world"],
    },
  };
  const required = ["owner", "repo"];
  if (verb !== "create" && verb !== "list" && verb !== "search") {
    properties.number = {
      type: "integer",
      title: "Number",
      description: `The number or id of the ${human} to operate on. Find it with list_${noun} or search_${noun}.`,
    };
    required.push("number");
  }
  if (verb === "create" || verb === "update") {
    properties.title = {
      type: "string",
      title: "Title",
      description: `The title of the ${human}. Plain text, at most 256 characters, shown in lists and notifications.`,
    };
    properties.body = {
      type: "string",
      title: "Body",
      description: `The body of the ${human} in GitHub-flavored Markdown. Mentions and issue references are linked automatically.`,
    };
  }
  if (verb === "list" || verb === "search") {
    properties.query = {
      type: "string",
      title: "Query",
      description: "Optional search qualifiers in GitHub search syntax, e.g. 'is:open label:bug author:octocat'.",
    };
    properties.per_page = {
      type: "integer",
      title: "Per page",
      description: "Results per page, between 1 and 100. Defaults to 30.",
      minimum: 1,
      maximum: 100,
      default: 30,
    };
    properties.page = { type: "integer", title: "Page", description: "Page number of the results to fetch, starting at 1.", minimum: 1 };
  }
  if (name === "get_release") {
    properties.big = { type: "boolean", title: "Big", description: "Return an enormous payload (test only)." };
  }
  const tool = {
    name,
    description,
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: `${name} arguments`,
      properties,
      required,
      additionalProperties: false,
    },
  };
  if (verb === "delete") tool.annotations = { destructiveHint: true };
  if (verb === "get" || verb === "list" || verb === "search") tool.annotations = { readOnlyHint: true };
  return tool;
}

const TOOLS = [];
for (const verb of Object.keys(VERBS)) for (const noun of Object.keys(NOUNS)) TOOLS.push(makeTool(verb, noun));

const server = new Server({ name: "fixture-github", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `no such tool ${name}` }] };
  if (name === "get_release" && args.big) {
    const words = Array.from({ length: 50_000 }, (_, i) => `word${i % 997}`).join(" ");
    return { content: [{ type: "text", text: words }], structuredContent: { size: 50_000 } };
  }
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, args }) }] };
});

await server.connect(new StdioServerTransport());
