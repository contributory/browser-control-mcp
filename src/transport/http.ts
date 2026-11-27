import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppContext } from "../tools/context.js";
import { registerTools } from "../tools/index.js";

const SERVER_NAME = "browser-control-mcp";
const SERVER_VERSION = "0.1.0";
const MCP_PATH = "/mcp";

export interface HttpService {
  server: Server;
  close(): Promise<void>;
}

/**
 * The MCP endpoint is stateless: every request gets a fresh McpServer and
 * transport with `sessionIdGenerator: undefined`. Remote browser state lives in
 * the process registry, keyed by browser_id and bound to the principal.
 */
export function createHttpService(ctx: AppContext): HttpService {
  const { config } = ctx;
  const credentials = config.authTokens.map(token => ({
    header: Buffer.from(`Bearer ${token}`),
    principal: principalId(token),
  }));

  const server = createServer(
    { requestTimeout: config.http.requestTimeoutMs },
    (request, response) => {
      void handle(ctx, credentials, request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    },
  );

  return {
    server,
    async close() {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** Stable, non-reversible principal id derived from the presented token. */
export function principalId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

interface Credential {
  header: Buffer;
  principal: string;
}

async function handle(
  ctx: AppContext,
  credentials: readonly Credential[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { config } = ctx;
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== MCP_PATH) {
    response.writeHead(404).end();
    return;
  }

  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (!config.allowedOrigins.has(origin)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
    response.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const principal = authenticate(credentials, request.headers.authorization);
  if (!principal) {
    response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    return;
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > config.http.maxRequestBytes) {
    response.writeHead(413).end();
    return;
  }

  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.once("close", () => {
    void transport.close().catch(() => {});
    void mcp.close().catch(() => {});
  });

  try {
    registerTools(mcp, ctx, principal);
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) response.writeHead(500);
    if (!response.writableEnded) response.end();
  }
}

/**
 * Constant-time bearer check across every configured token. Every candidate is
 * compared so timing does not reveal which one matched.
 */
function authenticate(credentials: readonly Credential[], header: string | undefined): string | null {
  if (!header) return null;
  const supplied = Buffer.from(header);
  let matched: string | null = null;
  for (const credential of credentials) {
    const sameLength = supplied.length === credential.header.length;
    const equal = sameLength && timingSafeEqual(supplied, credential.header);
    if (equal) matched = credential.principal;
  }
  return matched;
}
