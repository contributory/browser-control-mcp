import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ProviderSession } from "../providers/types.js";

export interface Connection {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Connects Playwright to a remote browser. Browsers are never launched or
 * installed locally; the endpoint always comes from a provider adapter.
 */
export async function connectRemote(
  session: ProviderSession,
  timeoutMs: number,
): Promise<Connection> {
  const browser =
    session.connectionKind === "playwright"
      ? await chromium.connect(session.endpoint, { timeout: timeoutMs })
      : await chromium.connectOverCDP(session.endpoint, { timeout: timeoutMs });

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await pickPage(context);
    return { browser, context, page };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** Keeps the provider's first usable tab, opening one when the browser has none. */
export async function pickPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  const open = pages.find(page => !page.isClosed());
  if (open) return open;
  return context.newPage();
}
