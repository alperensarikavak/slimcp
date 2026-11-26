export type * from "./types.js";
export { parseJsonc, stripJsonc, expandVars, normalizeServer, normalizeServers } from "./normalize.js";
export {
  CLIENTS,
  appDataDir,
  claudeCodeToolSearch,
  defaultContext,
  discoverSources,
  findClient,
  type ClientDef,
  type DiscoverContext,
  type ToolSearchStatus,
} from "./discover.js";
export { countTokens, toolTokens, truncateToTokens } from "./tokens.js";
export { connect, listAllTools, type Connection, type ConnectOptions } from "./connect.js";
export { minifySchema, minifyTool, minifyDescription } from "./minify.js";
export { SearchIndex, tokenize, stem, type SearchDoc, type SearchHit } from "./search.js";
export {
  buildExposure,
  isDestructive,
  renderHits,
  resolvePins,
  toolId,
  CALL_TOOL,
  FIND_TOOLS,
  type ExposedTool,
  type Exposure,
  type Route,
} from "./expose.js";
export { DEFAULT_OPTIONS, loadConfig, resolveConfig, resolveOptions } from "./config.js";
export { SlimProxy, runStdioProxy, capResult, type ProxyOptions } from "./proxy.js";
export { runAudit, grade, type AuditResult, type ClientReport, type AuditOptions } from "./audit.js";
export { renderReport, renderMarkdown, renderJson } from "./report.js";
export { planInit, applyInit, restore, renderPlan, slimcpEntry, type InitPlan, type InitOptions } from "./init.js";
export { slimcpHome, mostUsed, readUsage } from "./state.js";
export { parseArgs, guessName } from "./args.js";
export { VERSION } from "./version.js";
