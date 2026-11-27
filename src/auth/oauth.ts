export const OAUTH_SCOPE = "browser:control";
export const oauthToolMetadata = { securitySchemes: [{ type: "oauth2", scopes: [OAUTH_SCOPE] }] };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const accessTTL = 3600;
const codeTTL = 120;
const loginTTL = 600;
const defaultRedirect = "https://chatgpt.com/connector_platform_oauth_redirect";

type Env = Record<string, string | undefined>;
type Client = { redirect_uris: string[]; issued: number; id: string };
type Flow = { client_id: string; redirect_uri: string; code_challenge: string; state: string; nonce: string; exp: number };
type Refresh = { c: string };
type Grant = { client_id: string; resource: string; scope: string; exp: number; redirect_uri: string; code_challenge: string };
type Access = { aud: string; iss: string; scope: string; exp: number };

const now = () => Math.floor(Date.now() / 1000);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64(text: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("invalid encoding");
  const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), c => c.charCodeAt(0));
  if (b64(bytes) !== text) throw new Error("invalid encoding");
  return bytes;
}
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (value: string) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
const secureEqual = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
};
const list = (s: string | undefined) => (s ?? "").split(",").map(x => x.trim()).filter(Boolean);
const html = (s: string) => s.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]!);

function json(value: unknown, status = 200, extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { status, headers });
}
function error(code: string, status = 400, description?: string) { return json({ error: code, ...(description ? { error_description: description } : {}) }, status); }

export function isOAuthPath(path: string) {
  return ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server", "/oauth/resource", "/oauth/metadata",
    "/oauth/register", "/oauth/authorize", "/oauth/token"].includes(path);
}

/** Stateless private-deployment OAuth: all credentials are self-contained.
 * No database, process-local registry or external OAuth provider is required.
 */
export function createOAuth(env: Env, metadataPath = "/.well-known/oauth-protected-resource/mcp"): OAuthServer | undefined {
  if (!env.MCP_OAUTH_ISSUER?.trim()) return undefined;
  const url = new URL(env.MCP_OAUTH_ISSUER.trim());
  const loopback = url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("MCP_OAUTH_ISSUER must be an HTTPS origin");
  const passwords = list(env.MCP_AUTH_TOKEN);
  if (!passwords.length) throw new Error("MCP_AUTH_TOKEN is required");
  return new OAuthServer(url.origin, passwords, list(env.MCP_OAUTH_REDIRECT_URIS), metadataPath);
}

export class OAuthServer {
  readonly resource: string;
  readonly metadata: string;
  private readonly keys = new Map<number, Promise<CryptoKey>>();
  constructor(readonly issuer: string, private readonly passwords: string[], private readonly redirects: string[], metadataPath = "/.well-known/oauth-protected-resource/mcp") {
    this.resource = issuer + "/mcp";
    this.metadata = issuer + metadataPath;

  }

  challenge(invalid = false) {
    return 'Bearer resource_metadata="' + this.metadata + '", scope="' + OAUTH_SCOPE + '"' + (invalid ? ', error="invalid_token"' : "");
  }

  async authenticate(header: string | undefined | null): Promise<number> {
    const token = header?.match(/^Bearer (at_[A-Za-z0-9_-]+)$/i)?.[1];
    if (!token) return -1;
    const opened = await this.open<Access>("at", token);
    if (!opened) return -1;
    const access = opened.value;
    if (access.iss !== this.issuer || access.aud !== this.resource || access.scope !== OAUTH_SCOPE || !Number.isSafeInteger(access.exp) || access.exp <= now()) return -1;
    // The successfully authenticated encryption key identifies the principal,
    // never an owner/index asserted inside attacker-controlled plaintext.
    return opened.index;
  }

  private async passwordIndex(supplied: string) {
    const candidate = await digest(supplied);
    let matched = -1;
    for (let i = 0; i < this.passwords.length; i++) {
      if (secureEqual(candidate, await digest(this.passwords[i]!))) matched = i;
    }
    return matched;
  }

  /** Derive a distinct key for each configured bearer password. The public
   * issuer separates deployments, not a second required secret.
   * Lazy memoization within an invocation is optional; no persisted state. */
  private key(index: number): Promise<CryptoKey> {
    let key = this.keys.get(index);
    if (!key) {
      key = crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(["browser-control-mcp/oauth/v2", this.issuer, this.passwords[index]!])))
        .then(bytes => crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt","decrypt"]));
      this.keys.set(index,key);
    }
    return key;
  }

  private async seal(kind: string, value: unknown, index = 0) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new Uint8Array(await crypto.subtle.encrypt({ name:"AES-GCM", iv, additionalData:encoder.encode(this.issuer + ":v2:" + kind) }, await this.key(index), encoder.encode(JSON.stringify(value))));
    const packed = new Uint8Array(iv.length + bytes.length);
    packed.set(iv); packed.set(bytes, iv.length);
    return kind + "_v2_" + b64(packed);
  }
  private async open<T>(kind: string, value: string): Promise<{ value:T; index:number } | null> {
    const prefix = kind + "_v2_";
    if (!value.startsWith(prefix) || value.length > 16000) return null;
    let bytes: ReturnType<typeof unb64>;
    try { bytes = unb64(value.slice(prefix.length)); } catch { return null; }
    if (bytes.length < 28) return null;
    for (let index = 0; index < this.passwords.length; index++) {
      try {
        const raw = await crypto.subtle.decrypt({ name:"AES-GCM", iv:bytes.subarray(0,12), additionalData:encoder.encode(this.issuer + ":v2:" + kind) }, await this.key(index), bytes.subarray(12));
        const obj = JSON.parse(decoder.decode(raw));
        if (obj && typeof obj === "object") return {value:obj as T,index};
      } catch { /* Wrong key or invalid authentication tag. Try the next password. */ }
    }
    return null;
  }

  private allowedRedirect(uri: string) {
    try {
      const u = new URL(uri);
      if (uri.length > 512 || u.username || u.password || u.hash || u.href !== uri) return false;
      if (uri === defaultRedirect || (u.origin === "https://chatgpt.com" && /^\/connector\/oauth\/[A-Za-z0-9_-]{1,160}$/.test(u.pathname) && !u.search)) return true;
      return u.protocol === "https:" && this.redirects.includes(uri);
    } catch { return false; }
  }
  private async client(id: string, redirect?: string) {
    const c = (await this.open<Client>("client", id))?.value;
    if (!c || !Array.isArray(c.redirect_uris) || !c.redirect_uris.every(x => typeof x === "string" && this.allowedRedirect(x))) return null;
    if (redirect !== undefined && !c.redirect_uris.includes(redirect)) return null;
    return c;
  }

  async route(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "GET" && ["/oauth/resource","/.well-known/oauth-protected-resource","/.well-known/oauth-protected-resource/mcp"].includes(path)) {
        return json({ resource: this.resource, authorization_servers: [this.issuer], scopes_supported:[OAUTH_SCOPE], bearer_methods_supported:["header"] });
      }
      if (request.method === "GET" && ["/oauth/metadata","/.well-known/oauth-authorization-server"].includes(path)) {
        return json({ issuer:this.issuer, authorization_endpoint:this.issuer+"/oauth/authorize", token_endpoint:this.issuer+"/oauth/token", registration_endpoint:this.issuer+"/oauth/register", authorization_response_iss_parameter_supported:true, response_types_supported:["code"], response_modes_supported:["query"], grant_types_supported:["authorization_code","refresh_token"], code_challenge_methods_supported:["S256"], token_endpoint_auth_methods_supported:["none"], scopes_supported:[OAUTH_SCOPE] });
      }
      if (path === "/oauth/register" && request.method === "POST") return await this.register(request);
      if (path === "/oauth/authorize" && request.method === "GET") return await this.authorize(url.searchParams);
      if (path === "/oauth/authorize" && request.method === "POST") return await this.login(request);
      if (path === "/oauth/token" && request.method === "POST") return await this.exchange(request);
      return error("invalid_request", 405);
    } catch { return error("server_error", 503); }
  }

  private async body(request: Request, type: string) {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith(type) || Number(request.headers.get("content-length")) > 32768) return null;
    const text = await request.text();
    return encoder.encode(text).length <= 32768 ? text : null;
  }
  private async register(request: Request) {
    const raw = await this.body(request, "application/json");
    if (!raw) return error("invalid_client_metadata");
    let input;
    try { input = JSON.parse(raw); } catch { return error("invalid_client_metadata"); }
    if (!input || !Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 3 ||
        !input.redirect_uris.every((x: unknown) => typeof x === "string" && this.allowedRedirect(x))) return error("invalid_redirect_uri");
    if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== "none") return error("invalid_client_metadata");
    const client: Client = { redirect_uris:input.redirect_uris, issued:now(), id:random() };
    return json({ client_id:await this.seal("client", client), client_id_issued_at:client.issued, redirect_uris:client.redirect_uris, token_endpoint_auth_method:"none", grant_types:["authorization_code","refresh_token"], response_types:["code"], scope:OAUTH_SCOPE }, 201);
  }

  private async authorize(params: URLSearchParams) {
    const client_id = params.get("client_id") ?? "";
    const redirect_uri = params.get("redirect_uri") ?? "";
    if (!await this.client(client_id, redirect_uri)) return error("invalid_client");
    const state = params.get("state") ?? "";
    if (state.length > 4096) return error("invalid_request", 400, "Authorization state exceeds the supported size.");
    const reject = (code: string) => this.redirect(redirect_uri, state, { error:code });
    if (params.get("response_type") !== "code") return reject("unsupported_response_type");
    if (params.get("scope") && params.get("scope") !== OAUTH_SCOPE) return reject("invalid_scope");
    if (params.has("resource") && params.get("resource") !== this.resource) return reject("invalid_target");
    const code_challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(code_challenge)) return reject("invalid_request");
    const flow: Flow = { client_id, redirect_uri, code_challenge, state, nonce:random(), exp:now()+loginTTL };
    return this.form(await this.seal("flow",flow), flow.nonce);
  }

  private form(ticket: string, nonce: string, message = "", status = 200) {
    const secure = this.issuer.startsWith("https:") ? "; Secure" : "";
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Browser Control MCP · Authorize</title><style>body{font:16px system-ui,sans-serif;background:#f5f6f8;color:#17202c;display:grid;min-height:95vh;place-items:center;margin:0}main{background:white;padding:32px;border-radius:16px;width:min(360px,85vw);box-shadow:0 8px 30px #0001}h1{font-size:23px;margin:0 0 12px}p{line-height:1.5;color:#445}label{display:block;font-weight:600}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:8px;border-radius:8px;border:1px solid #aab}button{background:#152b44;color:white;font-weight:600;cursor:pointer}.error{color:#b42318}</style><main><h1>Connect Browser Control MCP</h1><p>Enter the MCP auth password to authorize browser control for this client.</p><p class="error" role="alert">${html(message)}</p><form method="post" action="${html(this.issuer+"/oauth/authorize")}"><input type="hidden" name="flow" value="${html(ticket)}"><label for="password">Auth password</label><input id="password" type="password" name="password" required autocomplete="current-password" maxlength="4096" autofocus><button type="submit">Authorize</button><button type="submit" name="deny" value="1" formnovalidate>Cancel</button></form></main></html>`, { status, headers:{
      "content-type":"text/html; charset=utf-8", "cache-control":"no-store", "pragma":"no-cache", "referrer-policy":"same-origin", "x-frame-options":"DENY", "x-content-type-options":"nosniff",
      "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "set-cookie":"mcp_oauth_csrf="+nonce+"; Path=/oauth/authorize; HttpOnly; SameSite=Strict; Max-Age="+loginTTL+secure,
    } });
  }

  private async login(request: Request) {
    const origin = request.headers.get("origin");
    // Browsers can send Origin: null after a no-referrer navigation or from
    // a privacy-preserving webview. A valid same-site CSRF cookie still
    // authenticates the form in that case. Reject explicit foreign origins.
    if (origin && origin !== "null" && origin !== this.issuer) {
      return error("invalid_request", 400, "Authorization form must be submitted from the OAuth server.");
    }
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return error("invalid_request", 400, "Cross-site authorization form submission is not allowed.");
    }
    const raw = await this.body(request, "application/x-www-form-urlencoded");
    if (raw === null) return error("invalid_request", 400, "Expected a URL-encoded authorization form.");
    const params = new URLSearchParams(raw);
    const ticket = params.get("flow") ?? "";
    const flow = (await this.open<Flow>("flow",ticket))?.value;
    const cookie = (request.headers.get("cookie") ?? "").split(";").map(x=>x.trim()).find(x=>x.startsWith("mcp_oauth_csrf="))?.slice("mcp_oauth_csrf=".length);
    if (!flow || flow.exp <= now() || !await this.client(flow.client_id,flow.redirect_uri)) {
      return error("invalid_request", 400, "Authorization form expired or is invalid. Restart the connection.");
    }
    // Some OAuth popup/webview clients do not retain the cookie. A browser-
    // supplied exact same-origin header is a valid independent CSRF defense
    // for a POST. A missing/opaque origin alone is never sufficient.
    const cookieMatches = Boolean(cookie && secureEqual(cookie,flow.nonce));
    if (!cookieMatches && (cookie || origin !== this.issuer)) {
      return error("invalid_request", 400, "Authorization form could not be verified. Reopen the login page in your browser.");
    }
    if (params.get("deny") === "1") return this.redirect(flow.redirect_uri,flow.state,{error:"access_denied"});
    const supplied = params.get("password") ?? "";
    const index = await this.passwordIndex(supplied);
    if (index < 0) return this.form(ticket,flow.nonce,"Incorrect auth password.",401);
    const grant: Grant = { client_id:flow.client_id,resource:this.resource,scope:OAUTH_SCOPE,exp:now()+codeTTL,redirect_uri:flow.redirect_uri,code_challenge:flow.code_challenge };
    // Short-lived sealed code binds the password key, client, redirect and
    // PKCE challenge. Without shared state it cannot be atomically consumed.
    return this.redirect(flow.redirect_uri,flow.state,{code:await this.seal("code",grant,index)});
  }

  private redirect(uri: string,state: string,values: Record<string,string>) {
    const url = new URL(uri);
    for (const [key,value] of Object.entries(values)) url.searchParams.set(key,value);
    if (state) url.searchParams.set("state",state);
    url.searchParams.set("iss",this.issuer);
    return new Response(null,{status:303,headers:{location:url.href,"cache-control":"no-store","referrer-policy":"no-referrer"}});
  }

  private async exchange(request: Request) {
    const raw = await this.body(request,"application/x-www-form-urlencoded");
    if (raw === null) return error("invalid_request");
    const p = new URLSearchParams(raw);
    const client_id = p.get("client_id") ?? "";
    if (!await this.client(client_id) || p.has("client_secret") || request.headers.has("authorization")) return error("invalid_client",401);
    if (p.has("resource") && p.get("resource") !== this.resource) return error("invalid_target");
    if (p.get("scope") && p.get("scope") !== OAUTH_SCOPE) return error("invalid_scope");
    const type = p.get("grant_type");
    let index: number;
    let refresh: string;
    if (type === "authorization_code") {
      const code = p.get("code") ?? "";
      const verifier = p.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !await this.client(client_id,p.get("redirect_uri")??"")) return error("invalid_grant");
      const opened = await this.open<Grant>("code",code);
      const decoded = opened?.value;
      if (!decoded || !Number.isSafeInteger(decoded.exp) || decoded.exp <= now() ||
          decoded.redirect_uri !== p.get("redirect_uri") ||
          !secureEqual(await digest(verifier),decoded.code_challenge??"")) return error("invalid_grant");
      if (decoded.client_id !== client_id || decoded.resource !== this.resource || decoded.scope !== OAUTH_SCOPE) return error("invalid_grant");
      index = opened!.index;
      refresh = "";
    } else if (type === "refresh_token") {
      refresh = p.get("refresh_token") ?? "";
      const opened = await this.open<Refresh>("rt",refresh);
      if (!opened || opened.value.c !== await digest(client_id)) return error("invalid_grant");
      index = opened.index;
    } else return error("unsupported_grant_type");
    const access: Access = { aud:this.resource,iss:this.issuer,scope:OAUTH_SCOPE,exp:now()+accessTTL };
    // The refresh credential is encrypted with the password that authorized
    // the grant. A successful authenticated decryption with a currently
    // configured password proves the credential is still valid. Neither the
    // password nor a plaintext password hash is included in its payload.
    if (!refresh) refresh = await this.seal("rt",{ c:await digest(client_id) } satisfies Refresh,index);
    return json({ access_token:await this.seal("at",access,index),token_type:"Bearer",expires_in:accessTTL,refresh_token:refresh,scope:OAUTH_SCOPE });
  }
}
