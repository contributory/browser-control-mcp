import assert from "node:assert/strict";
import { createHash, randomBytes, createDecipheriv } from "node:crypto";
import { handleServerless } from "../dist/transport/serverless.js";
import { createOAuth } from "../dist/auth/oauth.js";
import { createHttpService } from "../dist/transport/http.js";
import { loadConfig } from "../dist/config.js";
import { createProviders } from "../dist/providers/index.js";
import { SessionRegistry } from "../dist/browser/sessions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const issuer = "https://test.example";
const resource = issuer + "/mcp";
const password = "test-password-not-a-production-secret";
const env = { MCP_AUTH_TOKEN: password, MCP_OAUTH_ISSUER: issuer, BROWSER_ALLOWED_SERVICES: "no-provider" };
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const rpc = { jsonrpc:"2.0", id:1, method:"tools/list" };

async function exercise(name, call) {
  const post = (path, data, format="form", extra={}) => call(path, {
    method:"POST", headers:{"content-type":format==="json"?"application/json":"application/x-www-form-urlencoded",...extra},
    body:format==="json"?JSON.stringify(data):new URLSearchParams(data).toString(),
  });
  const discover = await call("/.well-known/oauth-protected-resource/mcp");
  assert.equal(discover.status,200);
  assert.equal((await discover.json()).resource,resource);
  const metadata = await call("/.well-known/oauth-authorization-server");
  assert.equal(metadata.status,200);
  assert.deepEqual((await metadata.json()).code_challenge_methods_supported,["S256"]);
  const unauthorized = await post("/mcp",rpc,"json",headers);
  assert.equal(unauthorized.status,401);
  assert.match(unauthorized.headers.get("www-authenticate"),/resource_metadata=/);
  const invalidReg = await post("/oauth/register",{redirect_uris:["https://attacker.example/callback"]},"json");
  assert.equal(invalidReg.status,400);
  const registered = await post("/oauth/register",{redirect_uris:[redirect],token_endpoint_auth_method:"none"},"json");
  assert.equal(registered.status,201);
  const { client_id } = await registered.json();
  const authParams={client_id,redirect_uri:redirect,response_type:"code",resource,scope:"browser:control",state:"test-state",code_challenge:challenge,code_challenge_method:"S256"};
  const login=await call("/oauth/authorize?"+new URLSearchParams(authParams));
  assert.equal(login.status,200);
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const page=await login.text();
  assert.match(page,/type="password"/);
  assert.match(login.headers.get("content-security-policy"), /form-action 'self';/);
  const wrongForm = await post("/oauth/authorize",{flow:page.match(/name="flow" value="([^"]+)"/)[1],password:"wrong"},"form",{origin:issuer});
  assert.equal(wrongForm.status,401);
  assert.match(wrongForm.headers.get("content-security-policy"), /form-action 'self';/);
  const flow=page.match(/name="flow" value="([^"]+)"/)[1];
  assert.equal((await post("/oauth/authorize",{flow,password})).status,400);
  assert.equal(login.headers.get("referrer-policy"),"same-origin");
  assert.match(login.headers.get("set-cookie"),/SameSite=Lax/);
  assert.match(cookie,/^mcp_oauth_csrf_[A-Za-z0-9_-]{16}=/);
  assert.equal((await post("/oauth/authorize",{flow,password:"wrong"},"form",{"sec-fetch-site":"same-origin",origin:"null"})).status,401);
  assert.equal((await post("/oauth/authorize",{flow,password},"form",{"sec-fetch-site":"same-site"})).status,400);
  const secondLogin=await call("/oauth/authorize?"+new URLSearchParams(authParams));
  const secondCookie=secondLogin.headers.get("set-cookie").split(";")[0];
  assert.notEqual(secondCookie.split("=")[0],cookie.split("=")[0]);
  assert.equal((await post("/oauth/authorize",{flow,password:"wrong"},"form",{cookie:secondCookie+"; "+cookie,origin:"null"})).status,401);
  // OAuth browser popups may send a null origin, or omit cookies.
  // Accept only a valid matching cookie OR a browser-supplied same-origin
  // header; foreign origins and mismatched cookies must still fail.
  assert.equal((await post("/oauth/authorize",{flow,password:"wrong"},"form",{cookie,origin:"null"})).status,401);
  assert.equal((await post("/oauth/authorize",{flow,password:"wrong"},"form",{origin:issuer})).status,401);
  assert.equal((await post("/oauth/authorize",{flow,password},"form",{origin:"null"})).status,400);
  assert.equal((await post("/oauth/authorize",{flow,password},"form",{cookie,origin:"https://evil.example"})).status,400);
  assert.equal((await post("/oauth/authorize",{flow,password},"form",{cookie:"mcp_oauth_csrf=wrong",origin:issuer})).status,400);
  assert.equal((await post("/oauth/authorize",{flow,password},"form",{cookie,origin:issuer,"sec-fetch-site":"cross-site"})).status,400);
  assert.equal((await post("/oauth/authorize",{flow,password:"wrong"},"form",{cookie,origin:issuer})).status,401);
  const approved=await post("/oauth/authorize",{flow,password},"form",{origin:issuer});
  async function checkContinuation(response, expectedTitle) {
    assert.equal(response.status,200);
    assert.equal(response.headers.get("location"),null);
    assert.match(response.headers.get("content-type"),/text\/html/);
    const body=await response.text();
    assert(body.includes(expectedTitle));
    assert.match(body,/Continue to ChatGPT/);
    assert(!body.includes(password));
    const href=body.match(/id="oauth-continue" href="([^"]+)"/)[1].replace(/&amp;/g,"&");
    const [,nonce,script]=body.match(/<script nonce="([^"]+)">([^<]+)<\/script>/);
    assert(response.headers.get("content-security-policy").includes("script-src 'nonce-"+nonce+"'"));
    let destination;
    runInNewContext(script,{
      document:{getElementById(id){assert.equal(id,"oauth-continue");return {href};}},
      window:{location:{replace(url){destination=url;}}},
    });
    assert.equal(destination,href);
    const callback=new URL(destination);
    assert.equal(callback.origin,"https://chatgpt.com");
    assert.equal(callback.pathname,new URL(redirect).pathname);
    return callback;
  }
  const callback=await checkContinuation(approved,"Authorization successful");
  const cancelled=await post("/oauth/authorize",{flow,deny:"1"},"form",{origin:issuer});
  const cancelCallback=await checkContinuation(cancelled,"Authorization cancelled");
  assert.equal(cancelCallback.searchParams.get("error"),"access_denied");
  assert.equal(cancelCallback.searchParams.get("state"),"test-state");
  const invalid=await call("/oauth/authorize?"+new URLSearchParams({...authParams,response_type:"token"}));
  assert.equal(invalid.status,303);
  assert.equal(new URL(invalid.headers.get("location")).searchParams.get("error"),"unsupported_response_type");
  assert.equal(callback.searchParams.get("state"),"test-state");
  assert.equal(callback.searchParams.get("iss"),issuer);
  const code=callback.searchParams.get("code");
  const grant={grant_type:"authorization_code",client_id,redirect_uri:redirect,resource,code,code_verifier:verifier};
  assert.equal((await post("/oauth/token",{...grant,code_verifier:"x".repeat(43)})).status,400);
  assert.equal((await post("/oauth/token",{...grant,resource:"https://wrong.example/mcp"})).status,400);
  const exchange=await post("/oauth/token",grant);
  assert.equal(exchange.status,200);
  const tokens=await exchange.json();
  assert.notEqual(tokens.refresh_token,password);
  assert.notEqual(tokens.access_token,password);
  assert.match(tokens.refresh_token,/^rt_v2_/);
  const packed=Buffer.from(tokens.refresh_token.slice("rt_v2_".length),"base64url");
  const key=createHash("sha256").update(JSON.stringify(["browser-control-mcp/oauth/v2",issuer,password])).digest();
  const decipher=createDecipheriv("aes-256-gcm",key,packed.subarray(0,12));
  decipher.setAAD(Buffer.from(issuer+":v2:rt"));
  decipher.setAuthTag(packed.subarray(-16));
  const decoded=JSON.parse(Buffer.concat([decipher.update(packed.subarray(12,-16)),decipher.final()]));
  assert.deepEqual(decoded,{c:createHash("sha256").update(client_id).digest("base64url")});
  assert(tokens.refresh_token.length < 120);
  const reordered=createOAuth({...env,MCP_AUTH_TOKEN:"another-random-password,"+password});
  assert.equal(await reordered.authenticate("Bearer "+tokens.access_token),1);
  assert.equal(tokens.expires_in,3600);
  const refresh={grant_type:"refresh_token",client_id,resource,refresh_token:tokens.refresh_token};
  assert.equal((await post("/oauth/token",{...refresh,refresh_token:password})).status,400);
  const refreshResult=await post("/oauth/token",refresh);
  assert.equal(refreshResult.status,200);
  const renewed=await refreshResult.json();
  assert.equal(renewed.refresh_token,tokens.refresh_token);
  assert.equal((await post("/oauth/token",refresh)).status,200);
  const otherReg=await post("/oauth/register",{redirect_uris:[redirect]},"json");
  const other=(await otherReg.json()).client_id;
  assert.equal((await post("/oauth/token",{...refresh,client_id:other})).status,400);
  const tampered=tokens.refresh_token.slice(0,5)+(tokens.refresh_token[5]==="A"?"B":"A")+tokens.refresh_token.slice(6);
  assert.equal((await post("/oauth/token",{...refresh,refresh_token:tampered})).status,400);
  assert.equal((await post("/mcp",rpc,"json",{...headers,authorization:"Bearer "+tokens.refresh_token})).status,401);
  const authed=await post("/mcp",rpc,"json",{...headers,authorization:"Bearer "+renewed.access_token});
  assert.equal(authed.status,200);
  const tools=(await authed.json()).result.tools;
  assert(tools.length>=15);
  assert(tools.every(t=>t._meta?.securitySchemes?.[0]?.type==="oauth2"));
  assert.equal((await post("/mcp",rpc,"json",{...headers,authorization:"Bearer "+password})).status,200);
  const fresh=createOAuth({...env});
  assert.equal(await fresh.authenticate("Bearer "+renewed.access_token),0);
  const rotated=createOAuth({...env,MCP_AUTH_TOKEN:"rotated-password"});
  assert.equal(await rotated.authenticate("Bearer "+renewed.access_token),-1);
  assert.equal((await rotated.route(new Request(issuer+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(refresh)}))).status,401);
  // This is an intentional stateless limitation: a valid code is replayable
  // with its verifier for the short lifetime; no false single-use guarantee.
  assert.equal((await post("/oauth/token",grant)).status,200);
  console.log("PASS:",name,"discovery, DCR, password form/CSRF, PKCE, access, reusable refresh, credential rotation, client/audience binding, tamper rejection.");
}

// Each request constructs a fresh server and registry, just like serverless.
await exercise("serverless", (path, init)=>handleServerless(new Request(issuer+path,init),{...env},{nativeBodyReader:true}));

// Exercise standalone actual HTTP server (test issuer stays canonical).
const config=loadConfig({...env,PORT:"0"});
const providers=createProviders(config);
const sessions=new SessionRegistry(config,providers);
const service=createHttpService({config,providers,sessions});
await new Promise(resolve=>service.server.listen(0,"127.0.0.1",resolve));
try {
  const base="http://127.0.0.1:"+service.server.address().port;
  await exercise("standalone",(path,init)=>fetch(base+path,{...init,redirect:"manual"}));
} finally {
  await service.close();
  await sessions.closeAll();
}

// Exercise Convex HTTP routes and internal Node bridge as independently
// bundled runtimes, without a database or any mutation API on the context.
const { build }=createRequire(import.meta.resolve("convex/server"))("esbuild");
const dir=await mkdtemp(join(process.cwd(),".convex-test-"));
const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
Object.assign(process.env,env);
try {
  await build({entryPoints:["convex/http.ts"],outfile:join(dir,"http.mjs"),bundle:true,format:"esm",platform:"browser",packages:"external"});
  await build({entryPoints:["convex/mcpNode.ts"],outfile:join(dir,"node.mjs"),bundle:true,format:"esm",platform:"node",packages:"external"});
  const {default:router}=await import(pathToFileURL(join(dir,"http.mjs")));
  const {handle}=await import(pathToFileURL(join(dir,"node.mjs")));
  const ctx={async runAction(_ref,args){
    assert.equal(args.tokenIndex,0);
    assert(!JSON.stringify(args.headers).includes(password));
    return handle._handler({},args);
  }};
  await exercise("Convex",(path,init)=>{
    const req=new Request(issuer+path,init);
    const [action]=router.lookup(new URL(req.url).pathname,req.method);
    return action._handler(ctx,req);
  });
} finally {
  for(const [k,v] of Object.entries(previous)) if(v===undefined)delete process.env[k];else process.env[k]=v;
  await rm(dir,{recursive:true,force:true});
}
