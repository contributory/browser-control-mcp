import { cp, rm } from "node:fs/promises";

// Keep compiled private server modules inside the Cloud Functions package,
// separate from the public static output. Never copy .env or node_modules.
const runtime = new URL("../cloud-functions/_runtime/", import.meta.url);
await rm(runtime, { recursive: true, force: true });
await cp(new URL("../dist/", import.meta.url), runtime, {
  recursive: true,
  filter: source => !source.endsWith("/dist/index.js") && !source.endsWith("/dist/transport/http.js"),
});
