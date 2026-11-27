import assert from "node:assert/strict";
import { proxyMcp } from "../shared/mcp-proxy.js";

const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const request = new Request("https://gateway.example/mcp", {
  method: "POST",
  headers: { authorization: "Bearer test", "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
  body: payload,
});
const response = await proxyMcp(request, "https://backend.example/mcp", async (url, options) => {
  assert.equal(url, "https://backend.example/mcp");
  assert.equal(options.headers.get("authorization"), "Bearer test");
  assert.equal(options.headers.get("mcp-protocol-version"), "2025-03-26");
  assert.equal(new TextDecoder().decode(options.body), payload);
  assert.equal(options.redirect, "manual");
  return new Response('{"result":{}}', { headers: { "content-type": "application/json" } });
});
assert.equal(response.status, 200);
assert.equal(await response.text(), '{"result":{}}');
assert.equal((await proxyMcp(new Request("https://gateway.example/mcp"), "", fetch)).status, 503);
assert.equal((await proxyMcp(new Request("https://gateway.example/mcp"), "https://backend.example/mcp", async () => { throw new Error("secret"); })).status, 502);
console.log("Proxy request forwarding and failure handling passed.");
