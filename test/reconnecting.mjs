import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { ReconnectingRegistry } from "../dist/browser/reconnecting.js";
import { SessionHandleCodec } from "../dist/browser/session-handle.js";

const config = loadConfig({ MCP_AUTH_TOKEN: "known-client-token", HYPERBROWSER_API_KEY: "private-provider-key", BROWSER_SESSION_MAX_LIFETIME_MS: "60000", BROWSER_SESSION_IDLE_TTL_MS: "30000" });
let now = Date.now();
let remoteActive = false, connects = 0, disconnects = 0, stops = 0, resumes = 0;
let count = 0, pageUrl = "about:blank";
const remote = {
  providerSessionId: "secret-provider-id", endpoint: "wss://private.example/?token=secret", connectionKind: "cdp",
  async stop() { remoteActive = false; stops++; },
};
const provider = {
  name: "hyperbrowser", connectionKind: "cdp",
  async activeCount() { return count; },
  async open(opts) { assert.equal(opts.reconnectable,true); assert.equal(opts.maxLifetimeMs,60000); remoteActive=true; return remote; },
  async resume(id) { assert.equal(id, remote.providerSessionId); resumes++; return remoteActive ? remote : null; },
};
const page = { url: () => pageUrl, isClosed: () => false };
const context = { pages: () => [page] };
const connect = async (r,_timeout,existingOnly) => {
  assert.equal(r, remote); assert.equal(existingOnly,true); connects++;
  return { context, page, browser: { async close() { disconnects++; } } };
};
const providers = { playwright: new Map([["hyperbrowser",provider],["browsercloud",{name:"browsercloud", connectionKind:"cdp"}]]) };
const registry = () => new ReconnectingRegistry(config, providers, connect, () => now);
const first = registry();
assert.deepEqual(first.listServices(), [{name:"browsercloud", reconnectable:false, workflows:true},{name:"hyperbrowser",reconnectable:true,workflows:true}]);
await assert.rejects(first.open("browsercloud","alice"), {code:"SERVICE_UNAVAILABLE"});
count=2;
await assert.rejects(first.open(undefined,"alice"),{code:"QUOTA_EXCEEDED"});
count=0;
const opened = await first.open(undefined,"alice");
assert(!opened.id.includes(remote.providerSessionId));
assert.equal(opened.summary().state,"active");
assert(remoteActive);
assert.equal(connects,1);
assert.equal(disconnects,1);
assert.equal(stops,0);
await first.closeAll();
assert(remoteActive);
const second = registry();
await assert.rejects(second.withSession(opened.id,"bob",async()=>{}),{code:"NOT_FOUND"});
await assert.rejects(second.withSession(opened.id.slice(0,10)+(opened.id[10]==="A"?"B":"A")+opened.id.slice(11),"alice",async()=>{}),{code:"NOT_FOUND"});
assert.equal(resumes,0);
await second.withSession(opened.id,"alice",async s=>{ assert.equal(s.page.url(),"about:blank");pageUrl="https://example.com"; });
await second.closeAll();
assert(remoteActive);
const third = registry();
await third.withSession(opened.id,"alice",async s=>assert.equal(s.page.url(),"https://example.com"));
await assert.rejects(third.withSession(opened.id,"alice",async()=>{throw new Error("operation failed");}),{code:"PROVIDER_ERROR"});
assert.equal(connects,4);
assert.equal(disconnects,4);
assert.equal(stops,0);
now+=60001;
await assert.rejects(third.withSession(opened.id,"alice",async()=>{}),{code:"SESSION_EXPIRED"});
assert.equal((await third.close(opened.id,"bob")).already_closed,true);
assert(remoteActive);
assert.equal((await third.close(opened.id,"alice")).closed,true);
assert.equal((await third.close(opened.id,"alice")).already_closed,true);
assert.equal(stops,1);
const forged = new SessionHandleCodec("known-client-token").encode({service:"hyperbrowser",providerId:remote.providerSessionId,owner:"alice",createdAt:now,expiresAt:now+10000});
await assert.rejects(third.withSession(forged,"alice",async()=>{}),{code:"NOT_FOUND"});
console.log("PASS: independent registries, provider-managed state, ownership, tampering, expiry, quota, disconnect and explicit stop.");
