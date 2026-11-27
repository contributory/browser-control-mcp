#!/usr/bin/env node
/**
 * Local HTTP smoke check for the MCP endpoint.
 *
 * Starts the built server with no provider credentials, then verifies the
 * stateless Streamable HTTP behaviour with the official MCP client SDK:
 * authentication, origin policy, tool discovery, and redacted error paths.
 * No network access, no live provider credentials, no browser binaries.
 *
 * Usage: npm run build && npm run smoke
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (!existsSync(new URL("../dist/index.js", import.meta.url))) {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const TOKEN = "smoke-test-token-0123456789";
const ALLOWED_ORIGIN = "http://allowed.example";
const results = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  const status = condition ? "PASS" : "FAIL";
  console.log(`${status}  ${name}${detail ? `  (${detail})` : ""}`);
}

function startServer() {
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: TOKEN,
      MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      // Force every provider to the unconfigured state, whatever the shell has.
      HYPERBROWSER_API_KEY: "",
      BROWSERCLOUD_TOKEN: "",
      PHANTOMJSCLOUD_API_KEY: "",
      BROWSER_ALLOWED_ORIGINS: "",
      BROWSER_ENABLE_EVALUATE: "false",
      BROWSER_ENABLE_CDP: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("server did not report a port")), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "listening" && typeof event.port === "number") {
            clearTimeout(timer);
            resolve(event.port);
            return;
          }
        } catch {
          /* ignore partial lines */
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => process.stderr.write(`[server] ${chunk}`));
    child.on("exit", code => reject(new Error(`server exited early with code ${code}`)));
  });

  return { child, port };
}

async function expectStatus(url, init) {
  const response = await fetch(url, init);
  await response.arrayBuffer().catch(() => {});
  return response.status;
}

const { child, port } = await startServer();
let baseUrl;
try {
  const resolvedPort = await port;
  baseUrl = `http://127.0.0.1:${resolvedPort}/mcp`;
  check("server reports a listening port", Number.isInteger(resolvedPort), `port ${resolvedPort}`);

  // --- Pure policy checks (no server required) ----------------------------
  const { DestinationPolicy } = await import("../dist/util/destination.js");
  const { Redactor } = await import("../dist/util/redact.js");

  const allowlist = new DestinationPolicy(["https://app.example.com", "https://*.docs.example.com"]);
  check("allowlist permits an exact host", Boolean(allowlist.check("https://app.example.com/x")));
  check("allowlist permits a wildcard subdomain", Boolean(allowlist.check("https://a.docs.example.com")));
  let blocked = false;
  try {
    allowlist.check("https://evil.example.com");
  } catch {
    blocked = true;
  }
  check("allowlist blocks other hosts", blocked);
  blocked = false;
  try {
    allowlist.check("http://app.example.com");
  } catch {
    blocked = true;
  }
  check("allowlist enforces the scheme", blocked);
  blocked = false;
  try {
    allowlist.check("https://user:pass@app.example.com");
  } catch {
    blocked = true;
  }
  check("URLs with embedded credentials are blocked", blocked);

  const openPolicy = new DestinationPolicy([]);
  check("default policy permits a public https URL", Boolean(openPolicy.check("https://example.com")));
  const privateHosts = ["http://localhost:3000", "http://127.0.0.1", "http://10.1.2.3", "http://169.254.169.254"];
  const stillBlocked = privateHosts.filter(candidate => {
    try {
      openPolicy.check(candidate);
      return false;
    } catch {
      return true;
    }
  });
  check("default policy blocks loopback and private hosts", stillBlocked.length === privateHosts.length, stillBlocked.join(","));

  const redactor = new Redactor([TOKEN, "provider_secret_value"]);
  check("redactor removes bearer tokens", !redactor.text(`Bearer ${TOKEN}`).includes(TOKEN));
  check(
    "redactor strips provider connection query strings",
    redactor.text("wss://chrome.example/ws?token=abc123").includes("?[redacted]"),
  );
  check("redactor removes API keys from messages", !redactor.text("key provider_secret_value failed").includes("provider_secret_value"));

  const { buildEvaluateWrapper } = await import("../dist/browser/operations.js");
  check(
    "evaluate wrapper returns a plain expression value",
    (await buildEvaluateWrapper("1 + 1")()) === 2,
  );
  check(
    "evaluate wrapper calls a function expression with the argument",
    (await buildEvaluateWrapper("(arg) => arg * 2")(21)) === 42,
  );
  check(
    "evaluate wrapper awaits an async function expression",
    (await buildEvaluateWrapper("async (arg) => arg + 1")(4)) === 5,
  );

  // --- HTTP edge behaviour -------------------------------------------------
  check(
    "unauthenticated request is rejected",
    (await expectStatus(baseUrl, { method: "POST" })) === 401,
  );
  check(
    "wrong bearer token is rejected",
    (await expectStatus(baseUrl, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-0000000000", "content-type": "application/json" },
      body: "{}",
    })) === 401,
  );
  check(
    "unknown path returns 404",
    (await expectStatus(baseUrl.replace("/mcp", "/other"), { method: "POST" })) === 404,
  );
  check(
    "disallowed Origin is rejected",
    (await expectStatus(baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example", "content-type": "application/json" },
      body: "{}",
    })) === 403,
  );
  check(
    "OPTIONS preflight from an allowed Origin succeeds",
    (await expectStatus(baseUrl, { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN } })) === 204,
  );

  // --- MCP protocol over Streamable HTTP ----------------------------------
  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  check("MCP initialize succeeds", true);

  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  const expected = [
    "playwright_list_services",
    "playwright_open",
    "playwright_navigate",
    "playwright_snapshot",
    "playwright_click",
    "playwright_fill",
    "playwright_press",
    "playwright_screenshot",
    "playwright_act",
    "playwright_evaluate",
    "playwright_console",
    "playwright_network",
    "playwright_cdp_send",
    "playwright_cdp_events",
    "playwright_close",
    "phantomjscloud_status",
    "phantomjscloud_render",
  ];
  for (const name of expected) {
    check(`tool ${name} is registered`, names.includes(name));
  }

  const services = await client.callTool({ name: "playwright_list_services", arguments: {} });
  const servicePayload = JSON.parse(services.content[0].text);
  check(
    "no services are listed without credentials",
    Array.isArray(servicePayload.services) && servicePayload.services.length === 0,
    JSON.stringify(servicePayload.services),
  );
  check(
    "capabilities report evaluate and CDP disabled by default",
    servicePayload.capabilities?.evaluate === false && servicePayload.capabilities?.cdp === false,
  );
  check(
    "destination policy is reported",
    servicePayload.destination_policy?.mode === "public-http-only",
  );

  const openResult = await client.callTool({ name: "playwright_open", arguments: { service: "hyperbrowser" } });
  check(
    "opening an unconfigured service fails with SERVICE_UNAVAILABLE",
    openResult.isError === true && JSON.parse(openResult.content[0].text).error?.code === "SERVICE_UNAVAILABLE",
  );

  const automaticOpen = await client.callTool({ name: "playwright_open", arguments: {} });
  check(
    "automatic selection reports SERVICE_UNAVAILABLE when no services exist",
    automaticOpen.isError === true && JSON.parse(automaticOpen.content[0].text).error?.code === "SERVICE_UNAVAILABLE",
  );

  const navigateResult = await client.callTool({
    name: "playwright_navigate",
    arguments: { browser_id: "deadbeefdeadbeefdeadbeefdeadbeef", url: "https://example.com" },
  });
  check(
    "unknown browser_id fails with NOT_FOUND",
    navigateResult.isError === true && JSON.parse(navigateResult.content[0].text).error?.code === "NOT_FOUND",
  );

  const evaluateResult = await client.callTool({
    name: "playwright_evaluate",
    arguments: { browser_id: "deadbeefdeadbeefdeadbeefdeadbeef", expression: "1+1" },
  });
  check(
    "evaluate is disabled by default",
    evaluateResult.isError === true && JSON.parse(evaluateResult.content[0].text).error?.code === "DISABLED",
  );

  const cdpResult = await client.callTool({
    name: "playwright_cdp_send",
    arguments: { browser_id: "deadbeefdeadbeefdeadbeefdeadbeef", method: "Performance.getMetrics" },
  });
  check(
    "CDP inspection is disabled by default",
    cdpResult.isError === true && JSON.parse(cdpResult.content[0].text).error?.code === "DISABLED",
  );

  const renderResult = await client.callTool({
    name: "phantomjscloud_render",
    arguments: { url: "https://example.com", format: "png" },
  });
  check(
    "phantomjscloud_render reports the service as unavailable",
    renderResult.isError === true && JSON.parse(renderResult.content[0].text).error?.code === "SERVICE_UNAVAILABLE",
  );

  const closeResult = await client.callTool({
    name: "playwright_close",
    arguments: { browser_id: "deadbeefdeadbeefdeadbeefdeadbeef" },
  });
  check(
    "closing an unknown browser_id is idempotent and not an error",
    closeResult.isError !== true && JSON.parse(closeResult.content[0].text).closed === false,
  );

  // A second client proves the endpoint is stateless: it must initialise and
  // list tools independently of the first client's MCP session.
  const second = new Client({ name: "smoke-client-2", version: "0.0.0" });
  await second.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  const secondTools = await second.listTools();
  check("a second client initialises independently", secondTools.tools.length === names.length);

  await client.close();
  await second.close();
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`\nFailed checks:\n${failed.map(result => `- ${result.name} ${result.detail}`).join("\n")}`);
  process.exitCode = 1;
}
