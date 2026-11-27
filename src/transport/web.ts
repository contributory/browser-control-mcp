import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppContext } from "../tools/context.js";
import { registerTools } from "../tools/index.js";

export interface WebHandlerOptions {
  /** EdgeOne's Request body is not guaranteed to be a WHATWG ReadableStream. */
  nativeBodyReader?: boolean;
}

/** Direct, stateless MCP handler for Node runtimes that provide Request/Response. */
export function createWebHandler(ctx: AppContext, options: WebHandlerOptions = {}): (request: Request) => Promise<Response> {
  const { config } = ctx;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const credentials = config.authTokens.map(token => ({
    digest: hash("Bearer " + token),
    principal: hash(token).toString("hex").slice(0, 32),
  }));

  return async request => {
    const headers = new Headers({ "Cache-Control": "no-store" });
    const respond = (status: number, body: string | null = null) => new Response(body, { status, headers });
    if (new URL(request.url).pathname !== "/mcp") return respond(404);

    const origin = request.headers.get("origin");
    if (origin !== null) {
      if (!config.allowedOrigins.has(origin)) return respond(403);
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
      headers.set("Access-Control-Expose-Headers", "mcp-session-id");
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    if (request.method === "OPTIONS") return respond(204);

    const supplied = hash(request.headers.get("authorization") ?? "");
    let principal: string | undefined;
    for (const credential of credentials) {
      if (timingSafeEqual(supplied, credential.digest)) principal = credential.principal;
    }
    if (!principal) {
      headers.set("WWW-Authenticate", "Bearer");
      return respond(401);
    }

    // The cloud function only serves finite responses, not a persistent GET SSE stream.
    if (request.method !== "POST") {
      headers.set("Allow", "POST, OPTIONS");
      return respond(405);
    }

    let parsedBody: unknown;
    if (options.nativeBodyReader) {
      // The platform has already buffered the incoming request. Read through
      // its native accessor, not the SDK's WHATWG stream reader. Check the
      // declared and actual UTF-8 size before handing parsed JSON to the SDK.
      const rpcError = (status: number, code: number, message: string) => {
        const errorHeaders = new Headers(headers);
        errorHeaders.set("Content-Type", "application/json");
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
          status, headers: errorHeaders,
        });
      };
      const tooLarge = () => rpcError(413, -32000, "Payload Too Large");
      if (Number(request.headers.get("content-length")) > config.http.maxRequestBytes) return tooLarge();
      const accept = request.headers.get("accept") ?? "";
      const contentType = request.headers.get("content-type") ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream") ||
          contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        // Let the SDK produce its standard 406/415 without reading the body.
        parsedBody = null;
      } else {
        try {
          const raw = await request.text();
          if (Buffer.byteLength(raw, "utf8") > config.http.maxRequestBytes) return tooLarge();
          parsedBody = JSON.parse(raw);
        } catch {
          return rpcError(400, -32700, "Parse error: Invalid JSON");
        }
      }
    }

    const mcp = new McpServer({ name: "browser-control-mcp", version: "0.1.0" });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: config.http.maxRequestBytes,
    });
    try {
      registerTools(mcp, ctx, principal);
      await mcp.connect(transport);
      // Stateless JSON mode returns a complete response.
      const result = await transport.handleRequest(request, options.nativeBodyReader ? { parsedBody } : undefined);
      const merged = new Headers(result.headers);
      headers.forEach((value, key) => merged.set(key, value));
      // Return a finite, platform-native response rather than forwarding a
      // WHATWG stream created by the SDK.
      const body = result.body === null ? null : await result.text();
      return new Response(body, { status: result.status, headers: merged });
    } catch {
      return respond(500, "MCP request failed");
    } finally {
      await mcp.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}
