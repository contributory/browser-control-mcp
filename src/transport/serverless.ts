import { createOAuth, isOAuthPath } from "../auth/oauth.js";
import { ReconnectingRegistry } from "../browser/reconnecting.js";
import { loadConfig } from "../config.js";
import { createProviders } from "../providers/index.js";
import { createWebHandler, type WebHandlerOptions } from "./web.js";

/** A complete MCP invocation, including cleanup, without a listener or timers. */
export async function handleServerless(request: Request, env: NodeJS.ProcessEnv, options: WebHandlerOptions = {}): Promise<Response> {
  const path = new URL(request.url).pathname;
  let oauth = options.oauth;
  if (!options.oauthHandledUpstream) {
    try { oauth ??= createOAuth(env); }
    catch { return new Response("OAuth configuration is invalid", { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
  if (isOAuthPath(path)) {
    return oauth ? oauth.route(request) : new Response(null, { status: 404 });
  }
  let config;
  let providers;
  try {
    config = loadConfig(env);
    providers = createProviders(config);
  } catch {
    return new Response("MCP server configuration is missing or invalid", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const sessions = new ReconnectingRegistry(config, providers);
  try {
    return await createWebHandler({ config, providers, sessions, sessionMode: "provider-managed", oauthEnabled: Boolean(oauth || (options.oauthHandledUpstream && env.MCP_OAUTH_ISSUER)) }, { ...options, oauth })(request);
  } finally {
    await sessions.closeAll();
  }
}
