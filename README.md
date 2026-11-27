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

Start with `playwright_list_services` to see which Playwright services are configured. Discovery reads server configuration and returns service names. Pass a name to `playwright_open` to choose a service, or omit it to randomly select a configured and allowed Hyperbrowser or BrowserCloud service. If neither is available, the server randomly selects a configured and allowed custom CDP service. Pass the returned `browser_id` to subsequent browser tools, and call `playwright_close` to release the session. PhantomJSCloud is discovered through the client’s MCP tool list.

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

## EdgeOne and Convex

The EdgeOne and Convex adapters expose the same stateless `/mcp` endpoint through a gateway. Run the standalone Node server as a persistent backend reachable over HTTPS, then set `MCP_BACKEND_URL` on the gateway to its full URL, such as `https://backend.example.com/mcp`. Configure `MCP_AUTH_TOKEN`, provider keys, destination policy, and allowed client origins on the backend. Clients send the same bearer token to the gateway, which forwards it to the backend.

Deploy `edge-functions/mcp.js` with EdgeOne Pages and set `MCP_BACKEND_URL` in its environment. For Convex, deploy `convex/http.ts` with the Convex CLI and set `MCP_BACKEND_URL` in the Convex deployment environment. The resulting endpoint uses the deployment's `.convex.site` domain.

The gateway does not host Playwright or retain browser connections. All requests for a browser session must reach the same persistent backend process. The adapters depend on the platform's HTTP request, response, and size limits. Validate the deployed endpoint with your provider and account before production use.

Run `node test/proxy.mjs` to check request forwarding locally.
