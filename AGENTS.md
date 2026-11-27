# Repository guide

This project serves browser automation tools over MCP Streamable HTTP at `/mcp`. Playwright connects to browsers hosted by providers. Use `playwright-core` and keep browser binaries and local browser processes out of the project.

## Project layout

- `src/index.ts` starts the process, reads configuration, and handles shutdown.
- `src/transport/` owns HTTP routing, authentication, request limits, and MCP transport setup.
- `src/providers/` contains adapters for provider credentials, session creation, cleanup, and provider-specific APIs.
- `src/browser/` owns Playwright connections, browser sessions, and browser operations.
- `src/tools/` declares MCP tool names, input schemas, and result formats. Call browser operations and provider adapters from here.
- `test/` contains smoke checks and tests that exercise observable behavior.
- `docs/` contains the English design and provider integration notes. Keep installation and usage in `README.md`.

Create a module or directory when it has a responsibility to own. Keep dependencies directed from the entry point and transport toward tools and their browser or provider operations. Keep MCP types out of provider adapters.

## Tool and provider conventions

- Keep MCP Streamable HTTP stateless by default. Create a fresh server and transport for each HTTP request. Authenticate every request and keep remote browser state in the separate registry keyed by `browser_id` and its owner.

- Share `playwright_` tools across providers that expose Playwright or compatible Chromium CDP. `playwright_list_services` returns implemented services with their required environment settings present. Listing a service should make no network requests.
- Prefix tools for a provider's separate API with that provider's name. Verify provider endpoints and lifecycle against official documentation and cite it in the design.
- Keep remote endpoints and credentials in server configuration. Return opaque browser IDs and sanitize provider errors before returning them to clients.
- Keep sessions bounded by time and capacity. Release provider resources after failed connections, explicit closes, expiry, and shutdown.
- Keep DevTools diagnostics scoped to the current page. Use named operations and a bounded sequence of supported browser actions for custom workflows.

## Checks

Run `npm ci` after dependency changes, `npm run check` for types, and `npm run build` for compiled output. Run the local smoke check documented in `README.md` after changes to MCP transport or tool registration. Keep checks independent of live provider credentials and identify any live integration paths you did not verify.

Write project documentation in English. Keep `.env.example` limited to variable names and non-secret examples.
