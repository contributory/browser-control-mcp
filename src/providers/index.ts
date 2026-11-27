import type { AppConfig } from "../config.js";
import { CustomCdpProvider } from "./custom-cdp.js";
import { BrowserCloudProvider } from "./browsercloud.js";
import { HyperbrowserProvider } from "./hyperbrowser.js";
import { PhantomJsCloudClient } from "./phantomjscloud.js";
import type { PlaywrightProvider } from "./types.js";

export interface Providers {
  /** Playwright/CDP providers with all required credentials configured. */
  readonly playwright: ReadonlyMap<string, PlaywrightProvider>;
  /** Dedicated HTTP render provider, when configured and allowed. */
  readonly phantomjscloud?: PhantomJsCloudClient;
}

/**
 * Builds adapters from configuration only. A provider is present when its
 * required settings exist and it passes `BROWSER_ALLOWED_SERVICES`; listing
 * makes no network calls and never reveals key values.
 */
export function createProviders(config: AppConfig): Providers {
  const env = config.providerEnv;
  const allowed = config.allowedServices;
  const isAllowed = (name: string) => allowed.length === 0 || allowed.includes(name);

  const playwright = new Map<string, PlaywrightProvider>();

  const hyperbrowserKey = env.HYPERBROWSER_API_KEY?.trim();
  if (hyperbrowserKey && isAllowed("hyperbrowser")) {
    playwright.set("hyperbrowser", new HyperbrowserProvider(hyperbrowserKey));
  }

  const browserCloudToken = env.BROWSERCLOUD_TOKEN?.trim();
  if (browserCloudToken && isAllowed("browsercloud")) {
    const endpoint = env.BROWSERCLOUD_ENDPOINT?.trim();
    playwright.set(
      "browsercloud",
      new BrowserCloudProvider(browserCloudToken, endpoint || undefined),
    );
  }

  const customNames = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("PLAYWRIGHT_CDP_") || !value?.trim()) continue;
    const suffix = key.slice("PLAYWRIGHT_CDP_".length);
    if (!/^[A-Za-z0-9_]+$/.test(suffix)) {
      throw new Error(`Invalid custom CDP service name in ${key}.`);
    }
    const name = suffix.toLowerCase();
    if (["hyperbrowser", "browsercloud", "phantomjscloud"].includes(name) || customNames.has(name)) {
      throw new Error(`Duplicate or reserved custom CDP service name: ${name}.`);
    }
    customNames.add(name);
    const provider = new CustomCdpProvider(name, value.trim());
    if (isAllowed(name)) playwright.set(name, provider);
  }

  const phantomKey = env.PHANTOMJSCLOUD_API_KEY?.trim();
  const phantomjscloud =
    phantomKey && isAllowed("phantomjscloud")
      ? new PhantomJsCloudClient(
          phantomKey,
          config.redactor,
          env.PHANTOMJSCLOUD_ENDPOINT?.trim() || undefined,
        )
      : undefined;

  return { playwright, phantomjscloud };
}
