# Setup and configuration

The server exposes MCP Streamable HTTP at `/mcp`. Playwright runs in this
process; browsers run at a provider. No browser binary is launched or installed
locally, and provider endpoints and credentials are never returned to clients.

## Requirements

- Node.js 22 or newer
- A provider account (see [providers.md](./providers.md)) for any non-mock use
- TLS terminated by a reverse proxy in front of this process for remote clients

## Install and build

```bash
npm ci
npm run check     # type check
npm run build     # compile to dist/
cp .env.example .env   # then fill in local values; never commit .env
node --env-file=.env dist/index.js
```

The server reads the process environment only and does not parse `.env` itself; use `--env-file` (Node 22+) or your process manager and secret store.

The process logs one JSON line on startup with the listening host and port, the
services whose credentials are configured, the destination policy mode, and
whether the privileged capabilities are enabled. It never logs keys, tokens, or
endpoints.

## Configuration

All configuration comes from the environment. Values are read once at startup.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | required | Comma-separated bearer tokens, 16+ characters each. The matched token identifies the principal that owns sessions. |
| `MCP_ALLOWED_ORIGINS` | empty | Browser origins allowed to call `/mcp`. Requests without an `Origin` header are accepted; browser requests must match. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback unless a proxy fronts the process. |
| `PORT` | `3000` | Bind port; `0` picks a free port (used by the smoke test). |
| `MCP_MAX_REQUEST_BYTES` | `262144` | Rejects larger declared request bodies with 413. |
| `MCP_REQUEST_TIMEOUT_MS` | `60000` | Per-request socket timeout. |
| `BROWSER_ALLOWED_ORIGINS` | empty | Destination allowlist for navigation and PhantomJSCloud renders. `https://host`, `https://host:port`, or `https://*.example.com`. Empty means public HTTP(S) only, with private/loopback/link-local blocked. |
| `BROWSER_ALLOWED_SERVICES` | empty | Restricts which configured services may be opened. Empty allows all configured services. |
| `BROWSER_SESSION_IDLE_TTL_MS` | `300000` | Close a session after this much inactivity. |
| `BROWSER_SESSION_MAX_LIFETIME_MS` | `900000` | Hard session lifetime cap. |
| `BROWSER_CONNECT_TIMEOUT_MS` | `30000` | Playwright connection timeout. |
| `BROWSER_ACTION_TIMEOUT_MS` | `15000` | Default timeout per browser action. |
| `BROWSER_MAX_SESSIONS_PER_PRINCIPAL` | `2` | Concurrent sessions per principal; also caps concurrent PhantomJSCloud renders. |
| `BROWSER_MAX_SESSIONS_TOTAL` | `8` | Concurrent sessions across all principals. |
| `BROWSER_MAX_PAGES` | `1` | Tabs kept per session; extra tabs are closed before each operation. |
| `BROWSER_MAX_OUTPUT_BYTES` | `65536` | Byte budget for snapshots, diagnostics reads, evaluate results and text renders. |
| `BROWSER_MAX_IMAGE_BYTES` | `1500000` | Byte budget for screenshots, PNG/JPEG and PDF renders. |
| `BROWSER_MAX_ACTION_STEPS` | `12` | Maximum steps in one `playwright_act` call. |
| `BROWSER_MAX_WAIT_MS` | `5000` | Longest explicit `wait` step. |
| `BROWSER_DIAGNOSTIC_MAX_ENTRIES` | `200` | Entries kept per console/network buffer or CDP subscription. |
| `BROWSER_DIAGNOSTIC_TTL_MS` | `300000` | Buffers expire after this long without a read. |
| `BROWSER_CDP_MAX_SUBSCRIPTIONS` | `4` | CDP event subscriptions per browser session. |
| `BROWSER_CDP_MAX_BYTES` | `32768` | Size limit for one CDP command result. |
| `BROWSER_ENABLE_EVALUATE` | `false` | Enables `playwright_evaluate` (privileged). |
| `BROWSER_ENABLE_CDP` | `false` | Enables `playwright_cdp_send` and `playwright_cdp_events` (privileged). |

Provider variables: `HYPERBROWSER_API_KEY`, `BROWSERCLOUD_TOKEN`,
`BROWSERCLOUD_ENDPOINT`,
`PHANTOMJSCLOUD_API_KEY`, `PHANTOMJSCLOUD_ENDPOINT`. See
[providers.md](./providers.md). A provider appears in
`playwright_list_services` only when its required values are present and it is
allowed; listing makes no network calls and does not validate the key.

## Connecting a client

```text
POST https://your-host/mcp
Authorization: Bearer <MCP_AUTH_TOKEN value>
Origin: https://app.example.com   (browser clients only)
```

The endpoint is stateless by default: each HTTP request gets a fresh MCP server
and transport with no MCP session id. Remote browser state is kept in this
process, keyed by `browser_id` and bound to the principal whose token was used,
so `playwright_open` in one request can be used by later requests with the same
token.

## Tools

Playwright tools work with every verified Playwright/CDP provider:

| Tool | Notes |
|---|---|
| `playwright_list_services` | Configured services, capability flags, destination policy, limits. Read-only. |
| `playwright_open` | Creates a provider session, returns a random `browser_id`. |
| `playwright_navigate` | Allowlisted HTTP(S) URL; returns URL, title, status. |
| `playwright_snapshot` | Size-limited page text, or HTML when no text. |
| `playwright_click`, `playwright_fill`, `playwright_press` | Ordinary interactions with timeouts; form values are never echoed. |
| `playwright_screenshot` | JPEG within `BROWSER_MAX_IMAGE_BYTES`. |
| `playwright_run` | One-call browser workflow: open, bounded actions, final snapshot, close. |
| `playwright_act` | Bounded sequence of the interactions above plus `wait_for_selector`, `scroll_into_view`, `wait`. No JavaScript or CDP. |
| `playwright_evaluate` | Privileged, disabled by default. |
| `playwright_console`, `playwright_network` | Bounded read-only buffers with dropped counters and TTL. |
| `playwright_cdp_send`, `playwright_cdp_events` | Privileged read-only inspection over an allowlist, disabled by default. |
| `playwright_close` | Idempotent; releases the provider session. |

PhantomJSCloud has its own HTTP render tools, `phantomjscloud_status` and
`phantomjscloud_render`; they do not create a Playwright session.

## Smoke test

The local check needs no credentials and no browser binary:

```bash
npm run build && npm run smoke
```

It starts `dist/index.js` on a free loopback port with every provider forced
unconfigured and verifies: bearer authentication (missing and wrong tokens),
404 for other paths, Origin rejection and preflight, MCP initialisation over
Streamable HTTP with two independent clients, all tool registrations, the
provider-quota and expiry error paths, privileged tools staying disabled by
default, idempotent close, the destination allowlist and private-address
blocking rules, and secret redaction. It exits non-zero on any failure.

## Deployment notes

- Terminate TLS at a proxy, bind to loopback locally, and keep the process
  single-replica unless you route browser operations to the owning replica; the
  session registry is process-local and page state cannot be recovered from
  another replica.
- Cap request bodies at the proxy as well; the server only checks the declared
  `Content-Length`.
- Navigation allowlists are enforced here, but the real SSRF boundary is the
  provider or its egress proxy. See [providers.md](./providers.md).
- `playwright_evaluate` and CDP run with the page's privileges. They are not a
  sandbox; enable them only with trusted clients and matching network policy.
