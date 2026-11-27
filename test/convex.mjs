import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Use the bundler already pinned by the Convex CLI.
const { build } = createRequire(import.meta.resolve("convex/server"))("esbuild");

const dir = await mkdtemp(join(process.cwd(), ".convex-test-"));
const env = {
  MCP_AUTH_TOKEN: "convex-test-token",
  MCP_ALLOWED_ORIGINS: "https://client.example",
  BROWSER_ALLOWED_SERVICES: "no-provider",
  MCP_MAX_REQUEST_BYTES: "1024",
};
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
try {
  // Exercise both independently bundled runtimes. The HTTP module must not
  // pull Node-specific Playwright code into the default Convex runtime.
  await build({
    entryPoints: ["convex/http.ts"], outfile: join(dir, "http.mjs"),
    bundle: true, format: "esm", platform: "browser", packages: "external",
  });
  await build({
    entryPoints: ["convex/mcpNode.ts"], outfile: join(dir, "node.mjs"),
    bundle: true, format: "esm", platform: "node", packages: "external",
  });
  const { default: router } = await import(pathToFileURL(join(dir, "http.mjs")));
  const { handle } = await import(pathToFileURL(join(dir, "node.mjs")));
  let invocations = 0;
  const context = {
    async runAction(_reference, args) {
      invocations++;
      assert.equal(args.tokenIndex, 0);
      assert(!JSON.stringify(args.headers).includes(env.MCP_AUTH_TOKEN));
      return handle._handler({}, args);
    },
  };
  const url = "https://example.convex.site/mcp";
  const call = (init = {}) => {
    const request = new Request(url, init);
    const [action] = router.lookup("/mcp", request.method);
    return action._handler(context, request);
  };
  const auth = { authorization: "Bearer " + env.MCP_AUTH_TOKEN };
  assert.equal((await call()).status, 401);
  assert.equal((await call({ headers: { ...auth, origin: "https://bad.example" } })).status, 403);
  assert.equal((await call({ method: "OPTIONS", headers: { origin: "https://client.example" } })).status, 204);
  assert.equal((await call({ headers: auth })).status, 405);
  assert.equal(invocations, 0);

  const headers = { ...auth, accept: "application/json, text/event-stream", "content-type": "application/json" };
  const post = body => call({ method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await call({ method: "POST", headers, body: "x".repeat(1025) })).status, 413);
  assert.equal(invocations, 0);
  const init = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name, "browser-control-mcp");
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.status, 200);
  const names = (await list.json()).result.tools.map(tool => tool.name);
  assert(names.includes("playwright_run"));
  assert(names.includes("phantomjscloud_render"));
  assert(names.includes("playwright_open"));
  assert(names.includes("playwright_cdp_send"));
  assert(!names.includes("playwright_console"));
  assert.equal(names.length, 15);
  const services = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "playwright_list_services", arguments: {} } });
  assert.equal(services.status, 200);
  assert.equal((await services.json()).result.structuredContent.session_mode, "provider-managed");
  console.log("PASS: Convex HTTP routing, auth, CORS, limits, internal Node action, MCP initialize/list/call.");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
}
