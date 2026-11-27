import { SessionRegistry } from "./browser/sessions.js";
import { loadConfig } from "./config.js";
import { createProviders } from "./providers/index.js";
import { createHttpService } from "./transport/http.js";

/**
 * Entry point. Reads configuration, builds provider adapters, starts the
 * stateless MCP HTTP endpoint, and releases provider resources on shutdown.
 */
const config = loadConfig();
const providers = createProviders(config);
const sessions = new SessionRegistry(config, providers);
sessions.startSweeper();

const service = createHttpService({ config, providers, sessions });

service.server.listen(config.port, config.host, () => {
  const address = service.server.address();
  const port = address && typeof address !== "string" ? address.port : config.port;
  console.log(
    JSON.stringify({
      event: "listening",
      host: config.host,
      port,
      path: "/mcp",
      services: sessions.listServices().map(service => service.name),
      phantomjscloud: Boolean(providers.phantomjscloud),
      destinations: config.destinations.configured ? "allowlist" : "public-http-only",
      evaluate: config.diagnostics.evaluateEnabled,
      cdp: config.diagnostics.cdpEnabled,
    }),
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  try {
    await service.close();
  } catch {
    /* the HTTP server may already be closed */
  }
  try {
    await sessions.closeAll();
  } catch {
    /* session release is best effort; provider errors are not surfaced */
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on("unhandledRejection", reason => {
  console.error(JSON.stringify({ event: "unhandledRejection", message: config.redactor.error(reason) }));
});
