import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolError } from "../util/errors.js";
import { guarded, ok } from "./results.js";
import type { AppContext } from "./context.js";

const browserId = z.string().min(8).max(1024);
const bufferAction = z.enum(["start", "read", "clear"]);

/**
 * Read-only DevTools diagnostics: bounded console and network buffers plus
 * allowlisted, read-only CDP inspection. No CDP or JavaScript mutation.
 */
export function registerDiagnosticTools(mcp: McpServer, ctx: AppContext, principal: string): void {
  const { config, sessions } = ctx;

  if (ctx.sessionMode !== "provider-managed") {
    mcp.registerTool(
      "playwright_console",
      {
        title: "Console diagnostics",
        description:
          "Start, read, or clear a bounded buffer of console messages and page errors. Reads drain the buffer and report how many entries were dropped.",
        inputSchema: z.object({
          browser_id: browserId,
          action: bufferAction,
        }),
        annotations: { readOnlyHint: true },
      },
      guarded(config.redactor, async ({ browser_id, action }) => {
        const result = await sessions.withSession(browser_id, principal, async session =>
          session.diagnostics.consoleAction(action),
        );
        return ok({ browser_id, action, ...result });
      }),
    );

    mcp.registerTool(
      "playwright_network",
      {
        title: "Network diagnostics",
        description:
          "Start, read, or clear a bounded buffer of request and response metadata. Headers and bodies are never captured; URL query strings are stripped.",
        inputSchema: z.object({
          browser_id: browserId,
          action: bufferAction,
        }),
        annotations: { readOnlyHint: true },
      },
      guarded(config.redactor, async ({ browser_id, action }) => {
        const result = await sessions.withSession(browser_id, principal, async session =>
          session.diagnostics.networkAction(action),
        );
        return ok({ browser_id, action, ...result });
      }),
    );

  }

  mcp.registerTool(
    "playwright_cdp_send",
    {
      title: "CDP command (read-only, privileged)",
      description:
        "Send one allowlisted, read-only CDP command to the current page target and return size-limited JSON. Disabled unless BROWSER_ENABLE_CDP=true. Arbitrary methods, target ids and endpoints are rejected.",
      inputSchema: z.object({
        browser_id: browserId,
        method: z.string().min(1).max(120),
        params: z.unknown().optional().describe("CDP parameters object."),
      }),
    },
    guarded(config.redactor, async ({ browser_id, method, params }) => {
      if (!config.diagnostics.cdpEnabled) {
        throw new ToolError(
          "DISABLED",
          "CDP inspection is disabled. Set BROWSER_ENABLE_CDP=true to enable read-only diagnostics.",
        );
      }
      if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
        throw new ToolError("INVALID_ARGUMENT", "params must be a JSON object.");
      }
      const result = await sessions.withSession(browser_id, principal, async session =>
        session.diagnostics.cdp.send(method, params as Record<string, unknown> | undefined),
      );
      return ok({ browser_id, method, result });
    }),
  );

  if (ctx.sessionMode !== "provider-managed") mcp.registerTool(
    "playwright_cdp_events",
    {
      title: "CDP event subscriptions (read-only, privileged)",
      description:
        "Subscribe to allowlisted page CDP events, read a buffered batch, or unsubscribe. Each subscription is owned by this browser session and principal, is bounded, and reports dropped events. Not a real-time stream. Disabled unless BROWSER_ENABLE_CDP=true.",
      inputSchema: z.object({
        browser_id: browserId,
        action: z.enum(["subscribe", "read", "unsubscribe"]),
        events: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
        subscription_id: z.string().min(1).max(64).optional(),
      }),
    },
    guarded(config.redactor, async ({ browser_id, action, events, subscription_id }) => {
      if (!config.diagnostics.cdpEnabled) {
        throw new ToolError(
          "DISABLED",
          "CDP inspection is disabled. Set BROWSER_ENABLE_CDP=true to enable read-only diagnostics.",
        );
      }
      return sessions.withSession(browser_id, principal, async session => {
        const cdp = session.diagnostics.cdp;
        if (action === "subscribe") {
          if (!events || events.length === 0) {
            throw new ToolError("INVALID_ARGUMENT", "events is required when action is subscribe.");
          }
          const subscription = await cdp.subscribe(events, config.diagnostics.maxEntries);
          return ok({
            browser_id,
            action,
            ...subscription,
            buffer_capacity: config.diagnostics.maxEntries,
          });
        }
        if (!subscription_id) {
          throw new ToolError(
            "INVALID_ARGUMENT",
            "subscription_id is required when action is read or unsubscribe.",
          );
        }
        if (action === "read") {
          const batch = cdp.read(subscription_id);
          return ok({ browser_id, action, subscription_id, ...batch });
        }
        const removed = cdp.unsubscribe(subscription_id);
        return ok({ browser_id, action, subscription_id, unsubscribed: removed });
      });
    }),
  );
}
