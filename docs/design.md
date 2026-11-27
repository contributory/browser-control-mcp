# Remote browser MCP server design

## Scope

Expose MCP Streamable HTTP at `/mcp`. Playwright runs in the server process, while browsers run at the provider. Never call `browserType.launch()` or install browser binaries. Select providers through server-side configuration; do not accept arbitrary endpoints or API keys from tool calls.

```text
MCP client -- HTTPS /mcp --> MCP server -- provider API --> remote session
                                    └-- Playwright/CDP WebSocket --> remote browser
```

## Provider capabilities

| Provider | Proposed integration | Status |
|---|---|---|
| Hyperbrowser | Create a session with the SDK, obtain `wsEndpoint`, connect with `chromium.connectOverCDP`, and stop the session through the SDK | Documented |
| BrowserCloud | Connect to the configured endpoint with a token using `chromium.connectOverCDP` | Documented; test with a real account |
| PhantomJSCloud | Dedicated HTTP Automation API: `POST /api/browser/v2/{key}/` with an `IPageRequest`; `outputAsJson: true` returns an `IUserResponse` | Verified against the vendor HTTP API documentation; no Playwright/CDP endpoint is offered |

Do not guess endpoints, authentication methods, or compatibility for unverified providers. If a name refers to a different product, obtain its documentation URL. Only enable Playwright providers with a confirmed Playwright or CDP endpoint. All enabled Playwright providers expose CDP, so `connectOverCDP` is the only connection path in use.

## Architecture

MCP Streamable HTTP is stateless by default. Instantiate the MCP server and transport per request with session ID generation disabled. Authenticate every request. Keep remote browser state in a separate registry indexed by `browser_id` and scoped to the authenticated caller.

- `config.ts`: environment parsing, limits, destination policy, and the secret redactor.
- `transport/`: MCP SDK and Streamable HTTP, bearer authentication, Origin checks, and request limits.
- `providers/`: interface `open(options) -> {providerSessionId, endpoint, connectionKind}` plus `stop()`; adapters manage provider APIs and credentials. Use `cdp` or `playwright` as `connectionKind` only when verified.
- `browser/`: connect with `chromium.connectOverCDP(endpoint)` or `chromium.connect(endpoint)` as appropriate; ordinary page operations and bounded console, network, and CDP diagnostics.
- `browser/sessions.ts`: registry associating browser sessions with authenticated principals, per-session locking, tab-count limits, idle TTL, maximum lifetime, quotas, and cleanup.
- `tools/`: schemas, authorization checks, and mappings to Playwright operations and provider adapters.
- `util/`: redaction, destination policy, size limits, and tool error codes.

Never expose endpoints or credentials in tool results or logs. BrowserCloud may require a token in the query string; redact the entire connection URL from logs and errors.

## MCP tools

Verified Playwright providers share the `playwright_` tools. `playwright_list_services()` returns providers with the required credentials configured, for example `[{"name":"hyperbrowser"}, {"name":"browsercloud"}]`. The list reflects configuration, not key validity or service availability; it does not call providers or reveal keys. List only implemented, verified providers. Omit providers with missing or empty credentials, or a missing required endpoint. `playwright_open(service)` checks configuration and access again before creating a session.

Providers with separate APIs have their own service-prefixed tools. PhantomJSCloud exposes `phantomjscloud_status()` (configuration only, no network call) and `phantomjscloud_render(url, format, ...)` with formats `png`, `jpeg`, `pdf`, `html` and `plainText`; they follow the documented HTTP API rather than simulating Playwright, share the destination policy, and enforce the same quotas, size limits and redaction. Service-specific tools must also enforce authentication, quotas, timeouts, and secret redaction.

- `playwright_open(service)`: create a browser session and return a random `browser_id`, without exposing the endpoint. The provider must be on the user's allowlist.
- `playwright_navigate(browser_id, url)`: navigate to an HTTP(S) URL and return the final URL, title, and status when available.
- `playwright_snapshot(browser_id)`: return size-limited page text or structure, URL, and title.
- `playwright_click(browser_id, selector)`, `playwright_fill(browser_id, selector, value)`, `playwright_press(browser_id, selector, key)`: perform actions with timeouts and clear errors.
- `playwright_screenshot(browser_id, full_page?)`: return size-limited MCP image content.
- `playwright_act(browser_id, steps)`: run a bounded, declarative sequence of ordinary interactions (`navigate`, `click`, `fill`, `press`, `wait_for_selector`, `scroll_into_view`, `wait`). Never evaluates JavaScript or sends CDP commands; reports the steps that completed before a failure.
- `playwright_evaluate(browser_id, expression, argument?)`: evaluate a JavaScript expression or function in the current page using `page.evaluate`; accept a JSON argument and return a serializable result with time and size limits. Code executes with the page's privileges and can change the page or send requests. Disabled unless `BROWSER_ENABLE_EVALUATE=true`.
- `playwright_cdp_send(browser_id, method, params?)`: send an allowlisted, read-only CDP command to the current page target via `context.newCDPSession(page)` and return size-limited JSON. Available only when Chromium and the provider support CDP sessions; otherwise return `UNSUPPORTED`. Arbitrary methods, WebSocket endpoints and target IDs are rejected. Disabled unless `BROWSER_ENABLE_CDP=true`.
- `playwright_cdp_events(browser_id, action, events?, subscription_id?)`: subscribe, retrieve batches, or unsubscribe from allowlisted page CDP events. Each subscription belongs to a browser session and principal, uses a bounded buffer, reports dropped events, and is cleaned up on close or expiry. This tool does not promise real-time streaming.
- `playwright_console(browser_id, action)`: start, read, or clear a bounded buffer of console messages and page errors with a TTL. Reads drain the buffer and report dropped entries.
- `playwright_network(browser_id, action)`: start, read, or clear bounded request and response metadata. Headers and bodies are never captured, and URL query strings are stripped.
- `playwright_close(browser_id)`: close the connection and release the provider session; the operation is idempotent.

Each tool checks ownership of `browser_id`. Serialize operations on the same session. Limit sessions per principal, execution time, output size, and tab count. Code execution and CDP are privileged capabilities: disable them by default, enable them through configuration, and grant access per principal only for sessions they own. Apply a deployment-specific allowlist of CDP methods and events; deny commands accessing the filesystem, other targets, or browser configuration outside the session unless explicitly authorized. Apply timeouts, quotas, and result limits; do not log code, form values, page content, or secrets. JavaScript and CDP are powerful and must not be treated as a secure sandbox. Enabling them must align with network policy and client trust.

## Lifecycle and operations

1. Authenticate requests before MCP processing. Use the official SDK for protocol versions and transport rather than implementing JSON-RPC. Validate Origin against configuration, terminate TLS at a reverse proxy, and bind to localhost when running locally.
2. On browser creation, record `creating`, call the provider, save the ID as soon as it is available, connect Playwright, and select a context and page according to the provider contract. On failure at any step, close the connection and stop any created provider session.
3. Transition `active` → `closing` → `closed`. Idle TTL and maximum lifetime trigger cleanup. Use `finally` for failures and release sessions during shutdown. Persist minimal metadata so a reconciliation job can reclaim orphaned sessions after a crash; do not store credentials in metadata.
4. With multiple replicas, route browser operations to the replica owning the connection using session affinity or owner-based routing; use a shared registry. If a replica dies, mark its sessions disconnected and reclaim them at the provider. Do not assume page state can be recovered.
5. Do not automatically retry click, fill, or navigation after a timeout because side effects may already have occurred. Retry idempotent cleanup with backoff and redact secrets from errors.

Configure `MCP_AUTH_TOKEN`, `MCP_ALLOWED_ORIGINS`, `BROWSER_ALLOWED_ORIGINS`, `BROWSER_ALLOWED_SERVICES`, `HYPERBROWSER_API_KEY`, `BROWSERCLOUD_TOKEN`, `PHANTOMJSCLOUD_API_KEY`, TTL and quotas through environment variables or a secret manager. The full reference is in `docs/setup.md`. Do not commit keys or include them in examples. Apply tenant-specific network policy to navigation, including redirects, DNS, and subresources. Block internal networks at the remote browser/provider or egress proxy: server-side URL checks alone cannot prevent SSRF. Provider-specific egress guidance is in `docs/providers.md`.

## Testing and deployment

Unit-test adapters with mock SDKs, including cleanup after create or connect failures, ownership checks, timeouts, and races between close and tool calls. Integration-test MCP HTTP with the client SDK, including multiple clients and session closure. `npm run smoke` starts the built server with every provider forced unconfigured and checks authentication, Origin handling, two independent stateless MCP clients, tool registration, quota and expiry error paths, privileged capabilities staying disabled, idempotent close, the destination policy, and secret redaction. Run contract tests with real credentials: create, navigate, interact, screenshot, close, and verify release. Enable a provider only after its contract tests pass; test billing, TTL, and provider network limits. Monitor active session count, duration, provider errors, and cleanup failures without logging page content or secrets.

## Sources

- Hyperbrowser: https://www.hyperbrowser.ai/browser-sessions
- BrowserCloud: https://browsercloud.io/docs/launch-options
- PhantomJSCloud: https://phantomjscloud.com/docs/http-api/ (Standard JSON API) and https://phantomjscloud.com/docs/http-api/automation/index.html
- Playwright: https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browsertype.md

## Provider-managed cloud sessions

Cloud Functions and Convex Node actions share the session contract with the
standalone in-memory registry. Hyperbrowser supports detached browser sessions
via the [session lifecycle](https://docs.hyperbrowser.ai/browser-sessions/lifecycle)
and SDK session get/stop operations. A confidential AES-GCM browser handle
contains the provider session identifier, owner and fixed expiration. The
handle key is independent of client authentication tokens. Reconnect uses the
provider API rather than accepting a client-supplied endpoint. The provider
maintains page state and enforces a hard lifetime; the MCP invocation opens and
disposes only its local Playwright connection. See README for the limitations
of stateless admission checks, idle timeout, and event subscriptions.
