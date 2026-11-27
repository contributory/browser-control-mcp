import assert from "node:assert/strict";
import { SessionRegistry } from "../dist/browser/sessions.js";
import { loadConfig } from "../dist/config.js";

const config = loadConfig({ MCP_AUTH_TOKEN: "test" });

async function selected(names, requested) {
  const providers = new Map(names.map(name => [name, {
    name,
    connectionKind: "cdp",
    async open() { throw new Error(`selected-${name}`); },
  }]));
  const registry = new SessionRegistry(config, { playwright: providers });
  try {
    await registry.open(requested, "owner");
    assert.fail("Expected mock provider to fail");
  } catch (error) {
    return error.message;
  }
}

assert.match(await selected(["custom"], undefined), /selected-custom/);
assert.match(await selected(["custom", "hyperbrowser"], undefined), /selected-hyperbrowser/);
assert.match(await selected(["custom", "browsercloud"], undefined), /selected-browsercloud/);
assert.match(await selected(["custom", "hyperbrowser"], "custom"), /selected-custom/);
assert.match(await selected([], undefined), /No Playwright services/);
for (let i = 0; i < 20; i++) {
  assert.match(await selected(["hyperbrowser", "browsercloud", "custom"], undefined), /selected-(hyperbrowser|browsercloud)/);
}
console.log("Service selection precedence and explicit selection passed.");
