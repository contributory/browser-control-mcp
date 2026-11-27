import { handleServerless } from "./serverless.js";

/** This repository's existing public EdgeOne deployment. Never infer an OAuth
 * issuer from an arbitrary request Host or forwarded header. Other projects
 * must configure their own canonical issuer explicitly.
 */
const productionIssuer = "https://browser-control-mcp.edgeone.dev";

interface EdgeOneContext {
  request: Request;
  env?: NodeJS.ProcessEnv;
}

export async function handleEdgeOne(context: EdgeOneContext): Promise<Response> {
  const env = { ...process.env, ...context.env };
  const origin = new URL(context.request.url).origin;
  // Some platform configurations expose the variable only in process.env.
  const configured = context.env?.MCP_OAUTH_ISSUER?.trim() || process.env.MCP_OAUTH_ISSUER?.trim();
  env.MCP_OAUTH_ISSUER = configured || (origin === productionIssuer ? productionIssuer : undefined);
  if (env.MCP_OAUTH_ENABLED?.trim().toLowerCase() === "false") delete env.MCP_OAUTH_ISSUER;
  const response = await handleServerless(context.request, env, {
    nativeBodyReader: true,
    // Advertise a direct function route so clients need not rely on rewriting
    // the resource metadata URL. The well-known endpoints remain available.
    oauthResourceMetadataPath: "/oauth/resource",
  });
  const headers = new Headers(response.headers);
  headers.set("X-MCP-Adapter", "edgeone-oauth-discovery-v3");
  headers.set("X-MCP-OAuth", env.MCP_OAUTH_ISSUER ? "configured" : "disabled");
  return new Response(response.body === null ? null : await response.text(), { status: response.status, headers });
}
