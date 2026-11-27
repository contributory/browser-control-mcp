import { oauthToolMetadata } from "../auth/oauth.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PhantomJsCloudFormat } from "../providers/phantomjscloud.js";
import { ToolError } from "../util/errors.js";
import { guarded, image, ok } from "./results.js";
import type { AppContext } from "./context.js";

/** Per-principal in-flight render requests; PhantomJSCloud has no session object. */
const inFlight = new Map<string, number>();

const format = z.enum(["png", "jpeg", "pdf", "html", "plainText"]);

/**
 * PhantomJSCloud dedicated render tools. These follow the documented HTTP
 * automation API (POST /api/browser/v2/{key}/) rather than Playwright:
 * https://phantomjscloud.com/docs/http-api/
 */
export function registerPhantomJsCloudTools(mcp: McpServer, ctx: AppContext, principal: string): void {
  const { config } = ctx;
  const client = ctx.providers.phantomjscloud;

  mcp.registerTool(
    "phantomjscloud_status",
    {
      ...(ctx.oauthEnabled ? { _meta: oauthToolMetadata } : {}),
      title: "PhantomJSCloud status",
      description:
        "Report whether PhantomJSCloud render tools are available (API key configured and service allowed). Makes no network calls.",
      annotations: { readOnlyHint: true },
    },
    guarded(config.redactor, async () => {
      return ok({
        available: Boolean(client),
        formats: ["png", "jpeg", "pdf", "html", "plainText"],
        note: client
          ? "PhantomJSCloud rendering is configured."
          : "Configure PHANTOMJSCLOUD_API_KEY and allow the service to enable rendering.",
      });
    }),
  );

  mcp.registerTool(
    "phantomjscloud_render",
    {
      ...(ctx.oauthEnabled ? { _meta: oauthToolMetadata } : {}),
      title: "Render URL with PhantomJSCloud",
      description:
        "Render an allowlisted URL with the PhantomJSCloud HTTP automation API. Returns an image, PDF (base64), HTML, or plain text within the configured size limits. This is not a Playwright session.",
      inputSchema: z.object({
        url: z.string().min(1).max(4_096).describe("Absolute HTTP(S) URL."),
        format,
        viewport: z
          .object({
            width: z.number().int().min(200).max(5_000),
            height: z.number().int().min(200).max(5_000),
          })
          .optional(),
        zoom_factor: z.number().min(0.1).max(5).optional(),
        selector: z.string().min(1).max(1_000).optional().describe("Clip to this element."),
        timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
      }),
    },
    guarded(config.redactor, async ({ url, format: renderFormat, viewport, zoom_factor, selector, timeout_ms }) => {
      if (!client) {
        throw new ToolError(
          "SERVICE_UNAVAILABLE",
          "PhantomJSCloud is not configured. Set PHANTOMJSCLOUD_API_KEY and allow the service.",
        );
      }
      const destination = config.destinations.check(url);
      const limit = config.session.maxSessionsPerPrincipal;
      const active = inFlight.get(principal) ?? 0;
      if (active >= limit) {
        throw new ToolError(
          "QUOTA_EXCEEDED",
          `At most ${limit} concurrent PhantomJSCloud renders are allowed per principal.`,
        );
      }

      inFlight.set(principal, active + 1);
      try {
        const binary = renderFormat === "png" || renderFormat === "jpeg" || renderFormat === "pdf";
        const result = await client.render({
          url: destination.toString(),
          format: renderFormat as PhantomJsCloudFormat,
          ...(viewport ? { viewportWidth: viewport.width, viewportHeight: viewport.height } : {}),
          ...(zoom_factor !== undefined ? { zoomFactor: zoom_factor } : {}),
          ...(selector ? { selector } : {}),
          timeoutMs: timeout_ms ?? 60_000,
          maxBytes: binary ? config.session.maxImageBytes : config.session.maxOutputBytes,
        });

        const meta: Record<string, unknown> = {
          url: destination.toString(),
          format: renderFormat,
          final_url: result.finalUrl,
          status_code: result.statusCode,
          content_type: result.contentType,
          bytes: result.data?.byteLength ?? Buffer.byteLength(result.text ?? "", "utf8"),
          truncated: result.truncated,
          credit_cost: result.creditCost,
          elapsed_ms: result.elapsedMs,
        };

        if (renderFormat === "png" || renderFormat === "jpeg") {
          return image(meta, result.data as Buffer, result.contentType);
        }
        if (renderFormat === "pdf") {
          return ok({ ...meta, encoding: "base64", data: (result.data as Buffer).toString("base64") });
        }
        return ok({ ...meta, encoding: "utf8", text: result.text ?? "" });
      } finally {
        const remaining = (inFlight.get(principal) ?? 1) - 1;
        if (remaining <= 0) inFlight.delete(principal);
        else inFlight.set(principal, remaining);
      }
    }),
  );
}
