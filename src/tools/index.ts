import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.js";
import { registerDiagnosticTools } from "./diagnostics.js";
import { registerPhantomJsCloudTools } from "./phantomjscloud.js";
import { registerPlaywrightTools } from "./playwright.js";

/**
 * Registers every tool for one authenticated principal. The caller builds a
 * fresh McpServer per HTTP request (stateless transport); browser state lives in
 * the process-wide session registry instead.
 */
export function registerTools(mcp: McpServer, ctx: AppContext, principal: string): void {
  registerPlaywrightTools(mcp, ctx, principal);
  if (ctx.sessionMode !== "request") registerDiagnosticTools(mcp, ctx, principal);
  registerPhantomJsCloudTools(mcp, ctx, principal);
}
