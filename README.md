# Browser Control MCP

Browser Control MCP exposes remote browser tools at `/mcp` over MCP Streamable HTTP. Hyperbrowser and BrowserCloud use the shared `playwright_` tools. PhantomJSCloud uses its own HTTP API through `phantomjscloud_` tools. The server uses `playwright-core` and connects to browsers hosted by the providers.

## Quick start

Requires Node.js 22 or later. Install the dependencies and build the server.

```bash
npm ci
npm run build
```

Create a local `.env` file with an MCP bearer token, at least one provider credential, and the origins you intend to browse. Generate a token with `openssl rand -hex 32` and replace the placeholders below. This example enables Hyperbrowser. See the provider table for other options.

```dotenv
MCP_AUTH_TOKEN=replace-with-a-generated-token
HYPERBROWSER_API_KEY=replace-with-your-hyperbrowser-key
BROWSER_ALLOWED_ORIGINS=https://example.com
```

```bash
node --env-file=.env dist/index.js
```

Set your MCP client transport to Streamable HTTP, its URL to `http://127.0.0.1:3000/mcp`, and its `Authorization` header to `Bearer <your MCP_AUTH_TOKEN>`. Send this header on every request. If your host injects the environment variables directly, start the server with `npm start`. Keep `.env` and provider credentials out of source control.

Start with `playwright_list_services` to see which Playwright services are configured. Discovery reads server configuration and returns service names. Pass a name to `playwright_open` to choose a service, or omit it to randomly select a configured and allowed Hyperbrowser or BrowserCloud service. If neither is available, the server randomly selects a configured and allowed custom CDP service. Pass the returned `browser_id` to subsequent browser tools, and call `playwright_close` to release the session. Alternatively, `playwright_run` opens, performs actions, snapshots and closes in one call. PhantomJSCloud is discovered through the client’s MCP tool list.

## Stateless MCP transport

MCP Streamable HTTP is stateless by default. Each HTTP request gets its own MCP server and transport instance. Clients authenticate every request and can call tools without an `Mcp-Session-Id`.

Remote browser sessions span tool calls. A `browser_id` identifies a session held by this server process and bound to the authenticated caller. Use the same bearer token for the lifetime of the browser session. With multiple server instances, route requests for a browser session to its owning instance. A server restart invalidates its browser IDs.

## Environment variables

### Server and access

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | Required | One bearer token or a comma-separated list of tokens. Each token identifies a separate caller. Use a strong token outside local development. |
| `HOST` | `127.0.0.1` | Address on which the server listens. |
| `PORT` | `3000` | HTTP port. Use `0` to choose an available port for local testing. |
| `MCP_ALLOWED_ORIGINS` | Empty | Comma-separated HTTP client origins. Set this if your client sends an `Origin` header. |
| `MCP_MAX_REQUEST_BYTES` | `262144` | Maximum MCP request body size in bytes. |
| `MCP_REQUEST_TIMEOUT_MS` | `60000` | HTTP request timeout in milliseconds. |
| `BROWSER_ALLOWED_SERVICES` | All configured services | Comma-separated provider names to expose. Names include `hyperbrowser`, `browsercloud`, `phantomjscloud`, and configured custom CDP service names. |
| `BROWSER_ALLOWED_ORIGINS` | Empty | Comma-separated browser destination origins, for example `https://app.example.com,https://*.example.org`. An empty list uses the default checks for public HTTP(S) destinations. |

The two origin variables apply to different connections. `MCP_ALLOWED_ORIGINS` controls which browser clients may send requests to the MCP server. `BROWSER_ALLOWED_ORIGINS` controls destinations passed to browser tools. Configure provider-side or proxy egress rules to enforce network restrictions on DNS resolution, redirects, and page resources.

### Providers

Set the credential for each provider you want to use. Provider credentials are optional for starting the server.

| Provider | Credential | Optional override |
| --- | --- | --- |
| Hyperbrowser | `HYPERBROWSER_API_KEY` | |
| BrowserCloud | `BROWSERCLOUD_TOKEN` | `BROWSERCLOUD_ENDPOINT` defaults to `wss://chrome-v2.browsercloud.io/`. |
| PhantomJSCloud | `PHANTOMJSCLOUD_API_KEY` | `PHANTOMJSCLOUD_ENDPOINT` defaults to `https://phantomjscloud.com/api/browser/v2`. |

To add an externally managed Chromium CDP endpoint, set an environment variable named `PLAYWRIGHT_CDP_<NAME>`. For example, `PLAYWRIGHT_CDP_MY_BROWSER=wss://browser.example.com/devtools/browser/your-session` registers the service `my_browser`. Names are case-insensitive and use letters, numbers, and underscores. Set multiple variables for multiple endpoints. Empty values are ignored. Built-in names are reserved, and duplicate names cause a startup error. HTTP(S) and WebSocket URLs are accepted. Include the custom name in `BROWSER_ALLOWED_SERVICES` when that allowlist is configured.

The server disconnects from the endpoint when its MCP browser session closes. The external provider owns the browser and its lifecycle. Use an isolated endpoint per session or caller when isolation is required, since an endpoint can expose an existing shared browser.


### Browser sessions and diagnostics

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER_SESSION_IDLE_TTL_MS` | `300000` | Idle session timeout in milliseconds. |
| `BROWSER_SESSION_MAX_LIFETIME_MS` | `900000` | Maximum session lifetime in milliseconds. Must be at least the idle timeout. |
| `BROWSER_CONNECT_TIMEOUT_MS` | `30000` | Timeout for connecting Playwright to the remote browser. |
| `BROWSER_ACTION_TIMEOUT_MS` | `15000` | Timeout for an individual browser action. |
| `BROWSER_MAX_SESSIONS_PER_PRINCIPAL` | `2` | Maximum concurrent sessions per bearer token. |
| `BROWSER_MAX_SESSIONS_TOTAL` | `8` | Maximum concurrent sessions per process. |
| `BROWSER_MAX_PAGES` | `1` | Maximum number of pages per session. |
| `BROWSER_MAX_OUTPUT_BYTES` | `65536` | Maximum textual output size in bytes. |
| `BROWSER_MAX_IMAGE_BYTES` | `1500000` | Maximum screenshot size in bytes. |
| `BROWSER_MAX_ACTION_STEPS` | `12` | Maximum steps per custom action sequence. |
| `BROWSER_MAX_WAIT_MS` | `5000` | Maximum explicit wait in an action step. |
| `BROWSER_DIAGNOSTIC_MAX_ENTRIES` | `200` | Maximum entries per diagnostic buffer. |
| `BROWSER_DIAGNOSTIC_TTL_MS` | `300000` | Diagnostic buffer retention time in milliseconds. |
| `BROWSER_ENABLE_EVALUATE` | `false` | Allow privileged JavaScript evaluation in the current page. Enable only for trusted callers. |
| `BROWSER_ENABLE_CDP` | `false` | Enable scoped CDP diagnostics for compatible Chromium providers. |
| `BROWSER_CDP_MAX_SUBSCRIPTIONS` | `4` | Maximum CDP subscriptions per browser session. |
| `BROWSER_CDP_MAX_BYTES` | `32768` | Maximum CDP parameter or result size in bytes. |

## Development

Run `npm run check` for TypeScript checks and `npm run build` to compile the server. The architecture and provider contracts are described in the [design document](docs/design.md). See the [repository guide](AGENTS.md) for the project layout.

## EdgeOne Pages (native Cloud Functions)

Deploy the repository to EdgeOne Pages using the root directory. The checked-in
`edgeone.json` selects `npm ci`, `npm run build:edgeone`, and the dedicated
`public/` static directory. The build copies the compiled private modules into
`cloud-functions/_runtime/`. The route `cloud-functions/mcp.js` handles
`/mcp` directly in EdgeOne's Node.js Cloud Functions runtime; there is no
MCP upstream URL or separate server. Configure `MCP_AUTH_TOKEN`, provider
credentials and other access settings in the project's environment variables.
Redeploy after changing them. Never put secrets in the static directory.

The [Node.js Cloud Functions documentation](https://pages.edgeone.ai/document/node-functions)
describes the Request/Response handler and file-based routing. The
[Cloud Functions limits](https://pages.edgeone.ai/document/cloud-functions)
specify Node.js 20.x, a 6 MB request/response limit, and a default 30-second
execution limit (subject to plan). Set provider and operation timeouts within
your deployment's actual deadline. Only finite JSON MCP responses are used;
GET SSE and DELETE are not supported. The EdgeOne handler reads JSON using
the platform's native Request accessor, enforces byte limits, and supplies
the parsed body to the MCP SDK rather than assuming its body is a standard
ReadableStream.

EdgeOne and Convex use a provider-managed session registry, with no listener,
background sweeper, database or external MCP server. Hyperbrowser retains
the remote browser using `keepAlive=true` (see [provider lifecycle docs](https://docs.hyperbrowser.ai/browser-sessions/lifecycle)).
`playwright_open` creates a remote browser and returns an encrypted,
authenticated browser ID bound to the caller. Subsequent tools resolve the
same session via the provider API, reconnect Playwright, and disconnect after
the operation. `playwright_close` explicitly stops the provider session.
Only the provider ID, owner and fixed expiry are encoded, never the endpoint
or provider credential. By default the handle key is derived from the
server-only Hyperbrowser API key; optionally set `BROWSER_SESSION_SECRET`
to a separate random secret (32+ random bytes), consistent across instances.
Do not use the client bearer token. Changing the encryption secret invalidates
existing IDs; provider-side expiry still cleans up those sessions.

Use `playwright_list_services` to distinguish reconnectable providers from
one-call workflow providers. Hyperbrowser supports both. BrowserCloud and
custom CDP endpoints continue to support `playwright_run` on cloud platforms
and persistent sessions on standalone Node.js. Reconnect is not assumed for
arbitrary custom CDP endpoints, which lack a verified creation/release contract.
The cloud endpoint exposes ordinary individual tools, action sequences,
evaluation and read-only CDP commands (subject to their existing privilege
flags). Continuous console/network/CDP event subscriptions remain available
only on standalone Node.js.

The stateless handle has a fixed lifetime (up to 45 minutes, rounded down to
the provider's minute granularity) enforced by the provider and the server.
There is no sliding idle expiration, distributed lock or exact per-owner
quota without shared state. Serialize calls per browser ID at the client.
The provider's account-wide active count is checked against the smaller of
the configured session caps before each reconnectable allocation; this is
a conservative admission check, not an atomic reservation. Use provider-side
hard quotas to bound concurrent allocations. One-call workflows retain their
request-local quotas. A deployment terminated mid-request relies on the
provider's expiry for cleanup.

Run `npm run build:edgeone && npm run smoke:edgeone` to test the native handler
without external credentials. Validate live browser connections and platform
limits on your deployment before production use.

## Convex (native HTTP Actions)

Deploy with `npx convex deploy` and configure the same environment variables
in Convex (for example `npx convex env set MCP_AUTH_TOKEN ...`). The endpoint is
`https://<deployment>.convex.site/mcp`. No separate server URL is needed.

`convex/http.ts` registers the HTTP endpoint, enforces access policy and body
limits, and calls `convex/mcpNode.ts` through Convex's internal action mechanism.
The internal Node action runs the same MCP handler and browser/provider code
as EdgeOne. This is necessary because Convex HTTP Actions do not support Node
APIs directly. See [HTTP Actions](https://docs.convex.dev/functions/http-actions)
and [Runtimes](https://docs.convex.dev/functions/runtimes). Neither adapter binds
a port or starts an HTTP server. Run `npm run check:convex && npm run smoke:convex`
for the local type and handler tests.

The standalone `npm start` mode is unchanged and continues to expose the full
persistent browser-session and diagnostic tool set. Both serverless adapters
use the shared provider-managed registry and one-call workflow described above.


## Stateless OAuth (ChatGPT)

Set the following environment variables on any deployment, and redeploy:

- `MCP_AUTH_TOKEN`: the existing password. Use a long, random value.
- `MCP_OAUTH_ISSUER`: canonical HTTPS origin of the server, without `/mcp`.
  For local testing only, HTTP loopback origins are accepted.
- Optional `MCP_OAUTH_REDIRECT_URIS`: extra exact HTTPS redirect URLs.
  ChatGPT's documented connector callbacks are already allowed.

Add the public `/mcp` URL to ChatGPT using OAuth. Discovery exposes resource
metadata, authorization-server metadata, dynamic client registration (public
clients), authorization code with PKCE S256, and the token endpoint. The
authorization page displays an **Auth password** field. Enter the configured
MCP password. Existing direct Bearer clients continue working.

No Redis, KV, database, session registry or external identity provider is
needed for OAuth, including on EdgeOne and Convex. Each invocation validates
self-contained AES-256-GCM credentials using a key derived from the
matching `MCP_AUTH_TOKEN` with SHA-256 with issuer separation. Token type,
issuer, scope and client identity are checked after authenticated decryption. Authorization codes expire after two
minutes; access tokens after one hour. The refresh token is reusable and has
no fixed expiry: each refresh attempts authenticated decryption with the
currently configured `MCP_AUTH_TOKEN` values. It is a distinct encrypted
credential, not the raw password or its hash. Removing a password invalidates
the access and refresh tokens encrypted under it. Client registration and
authorization form tickets use the first configured password; removing that
password requires re-registering affected clients. Old OAuth token formats
issued with the separate secret are not accepted; reconnect once after upgrade.

Since the password itself is the source of the encryption key, anyone who
knows a password can create OAuth tokens for that same principal, which already
has direct Bearer access. Captured encrypted tokens permit offline password
guessing because the key derivation is deliberately fast; use a high-entropy random password (e.g.
`openssl rand -hex 32`).

**Private-deployment tradeoffs:** without shared state, an authorization code
can be redeemed again with its original PKCE verifier before it expires,
refresh tokens are not rotated or individually revocable, and there is no
distributed login-attempt counter. This is not full OAuth replay protection.
Restrict deployments to trusted users, enforce request rate limits at the
platform/gateway, and use high-entropy passwords. Do not use this mode as a
public multi-tenant OAuth authorization server. See the [ChatGPT OAuth
documentation](https://developers.openai.com/plugins/build/auth).

Run `npm run build:edgeone && node test/oauth.mjs` for the local end-to-end
OAuth tests on standalone, serverless and bundled Convex handlers. Test
well-known route rewrites and the actual ChatGPT connection after deployment.
