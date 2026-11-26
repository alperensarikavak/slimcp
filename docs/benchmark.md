# slimcp benchmark

Measured 2026-11-26 with Node v22.20.0 on win32. Tokens are counted with the o200k_base tokenizer over `{name, description, input_schema}` of each tool, which is what a client sends to the model on every request. Counts are approximate (each model tokenizes differently and each client adds its own framing); the relative saving is what matters.

slimcp settings: defaults (`pin: ["auto"]` with no usage history yet, `minify: "safe"`, `catalog: "names"`). So the slimcp column is the two meta-tools `find_tools` + `call_tool`, whose description lists every hidden tool name.

## Tokens per request

| server | tools | normal tokens | slimcp tokens | saved |
|---|---:|---:|---:|---:|
| github | 26 | 3,546 | 320 | −91% |
| notion | 24 | 17,140 | 354 | −98% |
| playwright | 25 | 3,921 | 315 | −92% |
| filesystem | 14 | 1,678 | 268 | −84% |
| memory | 9 | 947 | 251 | −73% |
| everything | 13 | 1,075 | 280 | −74% |
| **All together** | **111** | **28,307** | **719** | **−97%** |

Packages:

- `@modelcontextprotocol/server-github@2025.4.8`
- `@notionhq/notion-mcp-server@2.6.1`
- `@playwright/mcp@0.0.86`
- `@modelcontextprotocol/server-filesystem@1.0.0`
- `@modelcontextprotocol/server-memory@1.0.0`
- `@modelcontextprotocol/server-everything@1.0.0`

## find_tools search quality

40 natural-language queries over all 111 tools at once (BM25 + stemming + synonyms, no embeddings, no network):

| top-1 | top-3 | top-5 |
|---:|---:|---:|
| 68% (27/40) | 85% (34/40) | 93% (37/40) |

Queries where the expected tool was not the first hit:

| query | expected | rank | top 3 returned |
|---|---|---:|---|
| file a bug report in the repo | `github__create_issue` | not in top 5 | `github__get_file_contents`, `github__push_files`, `github__get_pull_request_files` |
| show recent commits on main | `github__list_commits` | 2 | `github__push_files`, `github__list_commits`, `github__merge_pull_request` |
| which files changed in this pull request | `github__get_pull_request_files` | 2 | `github__create_pull_request`, `github__get_pull_request_files`, `github__update_pull_request_branch` |
| close an issue | `github__update_issue` | 5 | `playwright__browser_close`, `playwright__browser_tabs`, `github__get_issue` |
| approve a pull request with a review | `github__create_pull_request_review` | 2 | `github__get_pull_request_reviews`, `github__create_pull_request_review`, `github__get_pull_request_comments` |
| search my Notion workspace for meeting notes | `notion__API-post-search` | 3 | `notion__API-retrieve-page-markdown`, `memory__search_nodes`, `notion__API-post-search` |
| add a comment to a Notion page | `notion__API-create-a-comment` | 2 | `github__add_issue_comment`, `notion__API-create-a-comment`, `notion__API-retrieve-a-comment` |
| go to https://example.com | `playwright__browser_navigate` | not in top 5 | `notion__API-post-page`, `playwright__browser_drop`, `playwright__browser_navigate_back` |
| type text into the search box | `playwright__browser_type` | 5 | `memory__search_nodes`, `playwright__browser_find`, `github__search_repositories` |
| make a new folder | `filesystem__create_directory` | 5 | `filesystem__write_file`, `filesystem__edit_file`, `memory__create_entities` |
| add a new person to the knowledge graph | `memory__create_entities` | 2 | `memory__add_observations`, `memory__create_entities`, `memory__open_nodes` |
| look up what you know about Alice in memory | `memory__search_nodes` | not in top 5 | `everything__get-resource-links`, `memory__read_graph`, `everything__get-annotated-message` |
| add two numbers | `everything__get-sum` | 2 | `github__add_issue_comment`, `everything__get-sum`, `memory__add_observations` |

The full query list lives in [`scripts/benchmark.mjs`](../scripts/benchmark.mjs). Reproduce with `npm run bench`.
