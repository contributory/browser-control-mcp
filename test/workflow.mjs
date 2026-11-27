import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { createWebHandler } from "../dist/transport/web.js";

const config = loadConfig({ MCP_AUTH_TOKEN: "test-token", BROWSER_MAX_ACTION_STEPS: "2" });
let opens = 0;
let closes = 0;
let url = "about:blank";
const session = {
  id: "mock-browser",
  page: {
    async goto(target) { url = target; return { status: () => 200 }; },
    url: () => url,
    title: async () => "Example",
    locator: () => ({
      innerText: async () => "Example content",
      first: () => ({ click: async () => { throw new Error("mock click failure"); } }),
    }),
    screenshot: async () => Buffer.from("mock-jpeg"),
  },
};
const sessions = {
  listServices: () => [{ name: "mock" }],
  async open(service) { assert.equal(service, "mock"); opens++; return session; },
  async withSession(id, _principal, fn) { assert.equal(id, session.id); return fn(session); },
  async close(id) { assert.equal(id, session.id); closes++; },
};
const handler = createWebHandler({
  config, sessions, providers: { playwright: new Map() }, sessionMode: "request",
});
let id = 0;
async function run(args) {
  const response = await handler(new Request("https://test.example/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++id, method: "tools/call",
      params: { name: "playwright_run", arguments: { service: "mock", ...args } },
    }),
  }));
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
const navigate = { type: "navigate", url: "https://example.com" };
const success = await run({ steps: [navigate], screenshot: true });
assert.equal(success.structuredContent.snapshot.text, "Example content");
assert.equal(success.content[1].type, "image");
assert.equal(success.content[1].mimeType, "image/jpeg");
assert.equal(opens, 1);
assert.equal(closes, 1);
const fail = await run({ steps: [navigate, { type: "click", selector: "#missing" }] });
assert.equal(fail.isError, true);
assert.equal(fail.structuredContent.failed_step, 1);
assert.equal(opens, 2);
assert.equal(closes, 2);
const overLimit = await run({ steps: [navigate, navigate, navigate] });
assert.equal(overLimit.structuredContent.error.code, "INVALID_ARGUMENT");
assert.equal(opens, 2);
assert.equal(closes, 2);
console.log("PASS: one-call workflow snapshot, screenshot, action failure, quota validation, session cleanup.");
