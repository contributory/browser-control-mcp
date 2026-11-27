import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import onRequest from "../cloud-functions/mcp.js";

const url = new URL("https://cloud.example/mcp");
const token = "edgeone-test-token";
const env = {
  MCP_AUTH_TOKEN: token,
  MCP_ALLOWED_ORIGINS: "https://client.example",
  BROWSER_ALLOWED_SERVICES: "no-provider",
  MCP_MAX_REQUEST_BYTES: "1024",
};
// Model the Cloud Functions Request: native text() works even when body is
// not a WHATWG ReadableStream. Fails against the original SDK stream path.
function platformRequest(input, init) {
  const request = new Request(input, init);
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    text: () => request.text(),
    get body() { throw new Error("Platform request body is not a WHATWG stream"); },
  };
}
const call = (init = {}, target = url) => onRequest({ request: platformRequest(target, init), env });
const auth = { authorization: "Bearer " + token };
assert.equal((await call()).status, 401);
assert.equal((await call({ headers: { authorization: "Bearer wrong" } })).status, 401);
assert.equal((await call({ headers: { ...auth, origin: "https://bad.example" } })).status, 403);
const preflight = await call({ method: "OPTIONS", headers: { origin: "https://client.example" } });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get("access-control-allow-origin"), "https://client.example");
assert.equal((await call({ headers: auth })).status, 405);
assert.equal((await call({ headers: auth }, new URL("https://cloud.example/nope"))).status, 404);
const postHeaders = { ...auth, accept: "application/json, text/event-stream", "content-type": "application/json" };
assert.equal((await call({ method: "POST", headers: postHeaders, body: "x".repeat(1025) })).status, 413);
assert.equal((await call({ method: "POST", headers: postHeaders, body: "{" })).status, 400);
assert.equal((await call({ method: "POST", headers: postHeaders, body: '"é'.repeat(600) })).status, 413);
assert.equal((await call({ method: "POST", headers: { ...postHeaders, "content-length": "1025" }, body: "{}" })).status, 413);
assert.equal((await call({ method: "POST", headers: { ...postHeaders, accept: "text/plain" }, body: "{}" })).status, 406);
assert.equal((await call({ method: "POST", headers: { ...postHeaders, "content-type": "text/plain" }, body: "{}" })).status, 415);

const client = new Client({ name: "edgeone-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: auth },
  fetch: (input, init) => onRequest({ request: platformRequest(input, init), env }),
});
try {
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === "playwright_open"));
  assert(tools.some(tool => tool.name === "playwright_cdp_send"));
  assert(!tools.some(tool => tool.name === "playwright_console"));
  assert.equal(tools.length, 15);
  assert(tools.some(tool => tool.name === "playwright_run"));
  assert(tools.some(tool => tool.name === "phantomjscloud_render"));
  const services = await client.callTool({ name: "playwright_list_services", arguments: {} });
  assert.deepEqual(services.structuredContent.services, []);
  assert.equal(services.structuredContent.session_mode, "provider-managed");
  const result = await client.callTool({
    name: "playwright_run", arguments: { steps: [{ type: "navigate", url: "https://example.com" }] },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "SERVICE_UNAVAILABLE");
  console.log("PASS: native EdgeOne handler, auth, CORS, request limit, MCP initialize/list/call, no backend proxy.");
} finally {
  await client.close();
}
