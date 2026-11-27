import { httpRouter, httpActionGeneric, makeFunctionReference } from "convex/server";

const http = httpRouter();
const invoke = makeFunctionReference<"action", {
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  tokenIndex: number;
}, { status: number; headers: [string, string][]; body: string | null }>("mcpNode:handle");

const mcp = httpActionGeneric(async (ctx, request) => {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const respond = (status: number, body: string | null = null) => new Response(body, { status, headers });
  const tokens = (process.env.MCP_AUTH_TOKEN ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return respond(503, "MCP server configuration is missing or invalid");

  const origin = request.headers.get("origin");
  if (origin !== null) {
    const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim());
    if (!allowed.includes(origin)) return respond(403);
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Expose-Headers", "mcp-session-id");
  }
  if (request.method === "OPTIONS") return respond(204);

  // Reject unauthenticated traffic before invoking the Node action. Only the
  // matching token index crosses Convex's internal action boundary.
  const supplied = request.headers.get("authorization") ?? "";
  let tokenIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const candidate = "Bearer " + tokens[i];
    let difference = supplied.length ^ candidate.length;
    for (let j = 0; j < candidate.length; j++) {
      difference |= (supplied.charCodeAt(j) || 0) ^ candidate.charCodeAt(j);
    }
    if (difference === 0) tokenIndex = i;
  }
  if (tokenIndex < 0) {
    headers.set("WWW-Authenticate", "Bearer");
    return respond(401);
  }
  if (request.method !== "POST") {
    headers.set("Allow", "POST, OPTIONS");
    return respond(405);
  }

  // Limit the body before transferring it into the Node action.
  const maxBytes = Number(process.env.MCP_MAX_REQUEST_BYTES || 262144);
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4194304) {
    return respond(503, "MCP server configuration is missing or invalid");
  }
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return respond(413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel().catch(() => {});
          return respond(413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

  const forwarded: [string, string][] = [];
  for (const name of ["content-type", "accept", "origin", "mcp-protocol-version", "mcp-session-id"]) {
    const value = request.headers.get(name);
    if (value !== null) forwarded.push([name, value]);
  }
  try {
    const result = await ctx.runAction(invoke, {
      method: request.method, headers: forwarded, body: bytes.buffer, tokenIndex,
    });
    const responseHeaders = new Headers(result.headers);
    headers.forEach((value, key) => responseHeaders.set(key, value));
    return new Response(result.body, { status: result.status, headers: responseHeaders });
  } catch {
    return respond(500, "MCP request failed");
  }
});

for (const method of ["GET", "POST", "DELETE", "OPTIONS", "PUT", "PATCH"] as const) {
  http.route({ path: "/mcp", method, handler: mcp });
}
export default http;
