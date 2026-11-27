# Providers and egress guidance

Playwright connects to remote browsers only. The server never launches a local
browser, installs browser binaries, or accepts arbitrary endpoints or keys from
tool calls: everything comes from server-side configuration.

## Status

| Provider | Integration | Status |
|---|---|---|
| Hyperbrowser | Session via the official SDK; `wsEndpoint` + `chromium.connectOverCDP`; SDK stop | Verified against vendor documentation; contract test needs a real key |
| BrowserCloud | Configured endpoint + account token over `chromium.connectOverCDP` | Documented; connection contract still requires a real account test |
| PhantomJSCloud | Standard JSON / automation HTTP API: `POST /api/browser/v2/{key}/` with an `IPageRequest`, `outputAsJson: true` returns `IUserResponse` | Verified against the vendor HTTP API documentation (render types `png`, `jpeg`, `pdf`, `html`, `plainText`) |

Nothing here is a supported Playwright *server* endpoint: all three Playwright
providers use CDP, which is why `connectOverCDP` is the only connection path.

## Configuration

| Provider | Variables |
|---|---|
| Hyperbrowser | `HYPERBROWSER_API_KEY` |
| BrowserCloud | `BROWSERCLOUD_TOKEN`, optional `BROWSERCLOUD_ENDPOINT` (default `wss://chrome-v2.browsercloud.io/`) |
| PhantomJSCloud | `PHANTOMJSCLOUD_API_KEY`, optional `PHANTOMJSCLOUD_ENDPOINT` (default `https://phantomjscloud.com/api/browser/v2`) |

A provider is listed by `playwright_list_services` only when its required
values are present and `BROWSER_ALLOWED_SERVICES` permits it. Listing performs
no network calls, so a present key is not proof of validity or of available
quota. `playwright_open` re-checks configuration and access, then creates the
session.

## Lifecycle

1. Quota checks run before any provider call.
2. `creating` → provider `open()` → Playwright `connectOverCDP` → first context
   and page → `active`.
3. Any failure after the provider session exists closes the Playwright
   connection and stops the provider session.
4. `closing` → `closed` on client close, idle TTL, hard lifetime, browser
   disconnect, or process shutdown. Provider stop is attempted twice because it
   is idempotent.
5. Provider errors are redacted: connection URLs, tokens and query strings never
   reach clients or logs.

## Egress guidance

A remote browser makes requests from the provider's network, not from this
process. Server-side URL checks are necessary but not sufficient: a redirect, a
subresource, DNS rebinding, or a page script can reach a destination the tool
call never named. Configure the policy at the provider as well.

- **Allowlist destinations** with `BROWSER_ALLOWED_ORIGINS` and, at the
  provider, with its network policy or egress proxy. The two lists should agree.
- **Block internal networks at the provider**: loopback, RFC1918
  (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, including the
  `169.254.169.254` metadata endpoint), unique-local IPv6 (`fc00::/7`),
  `localhost`, and internal DNS suffixes. This server blocks these by default
  when no allowlist is configured, but only the provider can enforce them for
  redirects and subresources.
- **Follow redirects inside the same policy**, or deny them at the provider.
- **Keep credentials out of URLs.** URLs with embedded userinfo are rejected;
  provider tokens belong in headers or provider session objects.
- **Verify egress with a canary**: from a session, attempt to load an internal
  address and confirm the provider refuses it. Repeat for a redirect chain and
  for an image subresource.
- **Do not expose the provider's debug viewer or CDP URL** to clients. Only the
  opaque `browser_id` leaves the server.

PhantomJSCloud requests are checked against the same destination policy before
submission, but the same provider-side caveat applies: their browser fetches the
page from their infrastructure.

## Verification limits

The transport, tool registration, quotas, expiry, idempotent close, destination
policy and redaction are covered by the credential-free smoke check. Provider
contract tests (create, navigate, interact, screenshot, close, billing and TTL
behaviour) need live keys and were not run here. BrowserCloud's default
endpoint has been exercised against the vendor's documented connection shape
only, not against a real account.

## Sources

- Hyperbrowser sessions: https://www.hyperbrowser.ai/browser-sessions
- BrowserCloud launch options: https://browsercloud.io/docs/launch-options
- PhantomJSCloud HTTP API: https://phantomjscloud.com/docs/http-api/
- Playwright `browserType.connectOverCDP`: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
