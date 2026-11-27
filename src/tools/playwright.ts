import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as ops from "../browser/operations.js";
import { ToolError, isToolError } from "../util/errors.js";
import { guarded, image, ok } from "./results.js";
import type { AppContext } from "./context.js";

const browserId = z.string().min(8).max(128).describe("browser_id returned by playwright_open.");
const selectorSchema = z.string().min(1).max(2_000).describe("Playwright/CSS selector.");
const timeoutSchema = z
  .number()
  .int()
  .min(500)
  .max(120_000)
  .optional()
  .describe("Operation timeout in milliseconds.");

export function registerPlaywrightTools(mcp: McpServer, ctx: AppContext, principal: string): void {
  const { config, sessions } = ctx;
  const defaultTimeout = config.session.actionTimeoutMs;
  const timeout = (value: number | undefined) => value ?? defaultTimeout;

  mcp.registerTool(
    "playwright_list_services",
    {
      title: "List browser services",
      description:
        "List implemented browser services whose credentials are configured and allowed. Makes no network calls and never reveals keys or endpoints.",
      annotations: { readOnlyHint: true },
    },
    guarded(config.redactor, async () => {
      return ok({
        services: sessions.listServices(),
        phantomjscloud: { available: Boolean(ctx.providers.phantomjscloud) },
        capabilities: {
          evaluate: config.diagnostics.evaluateEnabled,
          cdp: config.diagnostics.cdpEnabled,
        },
        destination_policy: {
          mode: config.destinations.configured ? "allowlist" : "public-http-only",
          origins: config.destinations.describe(),
        },
        limits: {
          sessions_per_principal: config.session.maxSessionsPerPrincipal,
          max_lifetime_ms: config.session.maxLifetimeMs,
          idle_ttl_ms: config.session.idleTtlMs,
          max_output_bytes: config.session.maxOutputBytes,
          max_action_steps: config.session.maxActionSteps,
        },
      });
    }),
  );

  mcp.registerTool(
    "playwright_open",
    {
      title: "Open remote browser",
      description:
        "Create a remote browser session and return a random browser_id. When service is omitted, randomly choose an available Hyperbrowser or BrowserCloud service, or a custom service if neither is available.",
      inputSchema: z.object({
        service: z.string().trim().min(1).max(64).optional().describe("Optional service name from playwright_list_services."),
      }),
    },
    guarded(config.redactor, async ({ service }) => {
      const session = await sessions.open(service?.toLowerCase(), principal);
      return ok({ browser: session.summary() });
    }),
  );

  mcp.registerTool(
    "playwright_navigate",
    {
      title: "Navigate",
      description:
        "Navigate the session to an allowlisted HTTP(S) URL. Returns the settled URL, title and HTTP status when available.",
      inputSchema: z.object({
        browser_id: browserId,
        url: z.string().min(1).max(4_096).describe("Absolute HTTP(S) URL."),
        timeout_ms: timeoutSchema,
      }),
    },
    guarded(config.redactor, async ({ browser_id, url, timeout_ms }) => {
      const result = await sessions.withSession(browser_id, principal, session =>
        ops.navigate(session.page, config.destinations, url, timeout(timeout_ms)),
      );
      return ok({ browser_id, ...result });
    }),
  );

  mcp.registerTool(
    "playwright_snapshot",
    {
      title: "Page snapshot",
      description:
        "Return size-limited page text (or HTML when there is no visible text), plus URL and title.",
      inputSchema: z.object({
        browser_id: browserId,
        max_bytes: z.number().int().min(256).max(1_048_576).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(config.redactor, async ({ browser_id, max_bytes }) => {
      const budget = Math.min(max_bytes ?? config.session.maxOutputBytes, config.session.maxOutputBytes);
      const result = await sessions.withSession(browser_id, principal, session =>
        ops.snapshot(session.page, budget),
      );
      return ok({ browser_id, ...result });
    }),
  );

  mcp.registerTool(
    "playwright_click",
    {
      title: "Click",
      description: "Click the first element matching the selector and return the resulting URL.",
      inputSchema: z.object({
        browser_id: browserId,
        selector: selectorSchema,
        timeout_ms: timeoutSchema,
      }),
    },
    guarded(config.redactor, async ({ browser_id, selector, timeout_ms }) => {
      const result = await sessions.withSession(browser_id, principal, session =>
        ops.click(session.page, selector, timeout(timeout_ms)),
      );
      return ok({ browser_id, clicked: true, ...result });
    }),
  );

  mcp.registerTool(
    "playwright_fill",
    {
      title: "Fill field",
      description: "Fill an input matched by the selector. The value is never echoed back.",
      inputSchema: z.object({
        browser_id: browserId,
        selector: selectorSchema,
        value: z.string().max(10_000),
        timeout_ms: timeoutSchema,
      }),
    },
    guarded(config.redactor, async ({ browser_id, selector, value, timeout_ms }) => {
      await sessions.withSession(browser_id, principal, session =>
        ops.fill(session.page, selector, value, timeout(timeout_ms)),
      );
      return ok({ browser_id, filled: true, selector_length: selector.length, value_length: value.length });
    }),
  );

  mcp.registerTool(
    "playwright_press",
    {
      title: "Press key",
      description:
        "Press a keyboard key, either on the element matching the selector or on the focused element.",
      inputSchema: z.object({
        browser_id: browserId,
        key: z.string().min(1).max(64).describe("Playwright key name, e.g. Enter or Control+A."),
        selector: selectorSchema.optional(),
        timeout_ms: timeoutSchema,
      }),
    },
    guarded(config.redactor, async ({ browser_id, key, selector, timeout_ms }) => {
      const result = await sessions.withSession(browser_id, principal, session =>
        ops.press(session.page, selector, key, timeout(timeout_ms)),
      );
      return ok({ browser_id, pressed: true, ...result });
    }),
  );

  mcp.registerTool(
    "playwright_screenshot",
    {
      title: "Screenshot",
      description: "Capture a JPEG screenshot of the current page within the configured size limit.",
      inputSchema: z.object({
        browser_id: browserId,
        full_page: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(config.redactor, async ({ browser_id, full_page }) => {
      const shot = await sessions.withSession(browser_id, principal, session =>
        ops.screenshot(session.page, full_page ?? false, config.session.maxImageBytes),
      );
      return image(
        {
          browser_id,
          mime_type: shot.contentType,
          bytes: shot.data.byteLength,
          full_page: full_page ?? false,
        },
        shot.data,
        shot.contentType,
      );
    }),
  );

  mcp.registerTool(
    "playwright_evaluate",
    {
      title: "Evaluate JavaScript (privileged)",
      description:
        "Evaluate a JavaScript expression (or a function called with `argument`) in the page and return a size-limited JSON result. Disabled unless BROWSER_ENABLE_EVALUATE=true. Runs with the page's privileges and is not a sandbox: it can change the page or send requests.",
      inputSchema: z.object({
        browser_id: browserId,
        expression: z.string().min(1).max(8_000),
        argument: z.unknown().optional().describe("JSON value passed to the expression."),
      }),
    },
    guarded(config.redactor, async ({ browser_id, expression, argument }) => {
      if (!config.diagnostics.evaluateEnabled) {
        throw new ToolError(
          "DISABLED",
          "JavaScript evaluation is disabled. Set BROWSER_ENABLE_EVALUATE=true to enable it for trusted deployments.",
        );
      }
      const result = await sessions.withSession(browser_id, principal, session =>
        ops.evaluate(
          session.page,
          expression,
          argument,
          config.session.actionTimeoutMs,
          config.session.maxOutputBytes,
        ),
      );
      return ok({ browser_id, result });
    }),
  );

  mcp.registerTool(
    "playwright_close",
    {
      title: "Close browser",
      description: "Close the Playwright connection and release the provider session. Idempotent.",
      inputSchema: z.object({ browser_id: browserId }),
    },
    guarded(config.redactor, async ({ browser_id }) => {
      return ok(await sessions.close(browser_id, principal));
    }),
  );

  registerActTool(mcp, ctx, principal);
}

const actStep = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(4_096) }),
  z.object({ type: z.literal("click"), selector: selectorSchema }),
  z.object({ type: z.literal("fill"), selector: selectorSchema, value: z.string().max(10_000) }),
  z.object({ type: z.literal("press"), key: z.string().min(1).max(64), selector: selectorSchema.optional() }),
  z.object({ type: z.literal("wait_for_selector"), selector: selectorSchema, timeout_ms: timeoutSchema }),
  z.object({ type: z.literal("scroll_into_view"), selector: selectorSchema }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(60_000) }),
]);

/**
 * Bounded, declarative action sequence. Every step is an ordinary Playwright
 * interaction: no JavaScript evaluation and no CDP commands.
 */
function registerActTool(mcp: McpServer, ctx: AppContext, principal: string): void {
  const { config, sessions } = ctx;
  const defaultTimeout = config.session.actionTimeoutMs;

  mcp.registerTool(
    "playwright_act",
    {
      title: "Run action sequence",
      description:
        "Run an ordered, bounded sequence of ordinary browser interactions (navigate, click, fill, press, wait_for_selector, scroll_into_view, wait). No JavaScript or CDP is used.",
      inputSchema: z.object({
        browser_id: browserId,
        steps: z.array(actStep).min(1).max(50),
      }),
    },
    guarded(config.redactor, async ({ browser_id, steps }) => {
      if (steps.length > config.session.maxActionSteps) {
        throw new ToolError(
          "INVALID_ARGUMENT",
          `At most ${config.session.maxActionSteps} steps are allowed per call (BROWSER_MAX_ACTION_STEPS).`,
        );
      }
      const completed: Array<{ index: number; type: string; detail: Record<string, unknown> }> = [];
      const total = steps.length;

      for (const [index, step] of steps.entries()) {
        try {
          const detail = await sessions.withSession(browser_id, principal, async session => {
            const page = session.page;
            switch (step.type) {
              case "navigate": {
                const result = await ops.navigate(page, config.destinations, step.url, defaultTimeout);
                return { ...result };
              }
              case "click": {
                const result = await ops.click(page, step.selector, defaultTimeout);
                return { ...result };
              }
              case "fill": {
                await ops.fill(page, step.selector, step.value, defaultTimeout);
                return { filled: true };
              }
              case "press": {
                const result = await ops.press(page, step.selector, step.key, defaultTimeout);
                return { ...result };
              }
              case "wait_for_selector": {
                const wait = Math.min(step.timeout_ms ?? defaultTimeout, defaultTimeout);
                await page.locator(step.selector).first().waitFor({ state: "visible", timeout: wait });
                return { appeared: true };
              }
              case "scroll_into_view": {
                await ops.scrollIntoView(page, step.selector, defaultTimeout);
                return { scrolled: true };
              }
              case "wait": {
                const ms = Math.min(step.ms, config.session.maxWaitMs);
                await page.waitForTimeout(ms);
                return { waited_ms: ms };
              }
            }
          });
          completed.push({ index, type: step.type, detail });
        } catch (error) {
          const code = isToolError(error) ? error.code : "INTERNAL_ERROR";
          const message = isToolError(error) ? error.message : config.redactor.error(error);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: { code, message },
                  failed_step: index,
                  completed,
                  total,
                }),
              },
            ],
            structuredContent: { error: { code, message }, failed_step: index, completed, total },
          };
        }
      }
      return ok({ browser_id, completed, total });
    }),
  );
}
