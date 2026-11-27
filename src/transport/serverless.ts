import { ReconnectingRegistry } from "../browser/reconnecting.js";
import { loadConfig } from "../config.js";
import { createProviders } from "../providers/index.js";
import { createWebHandler, type WebHandlerOptions } from "./web.js";

/** A complete MCP invocation, including cleanup, without a listener or timers. */
export async function handleServerless(request: Request, env: NodeJS.ProcessEnv, options: WebHandlerOptions = {}): Promise<Response> {
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
    return await createWebHandler({ config, providers, sessions, sessionMode: "provider-managed" }, options)(request);
  } finally {
    await sessions.closeAll();
  }
}
