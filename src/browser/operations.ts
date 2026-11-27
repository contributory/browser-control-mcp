import type { Page } from "playwright-core";
import type { DestinationPolicy } from "../util/destination.js";
import { ToolError } from "../util/errors.js";
import { serializeLimited, truncateBytes } from "../util/limits.js";

export interface NavigateResult {
  url: string;
  title: string;
  status?: number;
}

export interface SnapshotResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  kind: "text" | "html";
}

export interface ScreenshotResult {
  data: Buffer;
  contentType: "image/jpeg";
}

/** Navigates to an allowlisted HTTP(S) URL and reports the settled location. */
export async function navigate(
  page: Page,
  policy: DestinationPolicy,
  rawUrl: string,
  timeoutMs: number,
): Promise<NavigateResult> {
  const url = policy.check(rawUrl);
  const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const title = await safeTitle(page);
  return {
    url: page.url(),
    title,
    ...(response ? { status: response.status() } : {}),
  };
}

/**
 * Returns the page's visible text when there is any, otherwise the HTML
 * document, truncated to the configured byte budget.
 */
export async function snapshot(page: Page, maxBytes: number): Promise<SnapshotResult> {
  const title = await safeTitle(page);
  let text = "";
  let kind: "text" | "html" = "text";
  try {
    text = await page.locator("body").innerText({ timeout: 5_000 });
  } catch {
    text = "";
  }
  if (text.trim().length === 0) {
    kind = "html";
    text = await page.content();
  }
  const limited = truncateBytes(text, maxBytes);
  return {
    url: page.url(),
    title,
    text: limited.text,
    truncated: limited.truncated,
    kind,
  };
}

export async function click(page: Page, selector: string, timeoutMs: number): Promise<{ url: string }> {
  await page.locator(selector).first().click({ timeout: timeoutMs });
  return { url: page.url() };
}

export async function fill(
  page: Page,
  selector: string,
  value: string,
  timeoutMs: number,
): Promise<{ filled: true }> {
  // The value is never echoed in results, errors, or logs.
  await page.locator(selector).first().fill(value, { timeout: timeoutMs });
  return { filled: true };
}

export async function press(
  page: Page,
  selector: string | undefined,
  key: string,
  timeoutMs: number,
): Promise<{ url: string }> {
  if (!key.trim()) throw new ToolError("INVALID_ARGUMENT", "key must not be empty.");
  if (selector) {
    await page.locator(selector).first().press(key, { timeout: timeoutMs });
  } else {
    await page.keyboard.press(key);
  }
  return { url: page.url() };
}

export async function scrollIntoView(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<{ scrolled: true }> {
  await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: timeoutMs });
  return { scrolled: true };
}

/** Captures a JPEG, stepping quality down once before reporting it too large. */
export async function screenshot(
  page: Page,
  fullPage: boolean,
  maxBytes: number,
): Promise<ScreenshotResult> {
  for (const quality of [70, 35]) {
    const data = await page.screenshot({ type: "jpeg", quality, fullPage });
    if (data.byteLength <= maxBytes) return { data, contentType: "image/jpeg" };
  }
  throw new ToolError(
    "OUTPUT_TOO_LARGE",
    `The screenshot exceeds the ${maxBytes} byte limit; request a smaller viewport or skip full_page.`,
  );
}

/**
 * Evaluates a JavaScript expression in the page, optionally passing a JSON
 * argument. If the expression evaluates to a function, it is called with the
 * argument. Disabled unless `BROWSER_ENABLE_EVALUATE=true`.
 */
/**
 * Compiles the privilege boundary for `playwright_evaluate`: the wrapper is built
 * in Node, and only the caller's expression is sent to and evaluated in the page.
 */
export function buildEvaluateWrapper(expression: string): (arg: unknown) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(
    `return async function (arg) { const value = (${expression}); return typeof value === "function" ? await value(arg) : value; };`,
  ) as () => (arg: unknown) => Promise<unknown>;
  return build();
}

export async function evaluate(
  page: Page,
  expression: string,
  argument: unknown,
  timeoutMs: number,
  maxBytes: number,
): Promise<unknown> {
  if (expression.trim().length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "expression must not be empty.");
  }
  if (expression.length > 8_000) {
    throw new ToolError("INVALID_ARGUMENT", "expression must be at most 8000 characters.");
  }
  const wrapper = buildEvaluateWrapper(expression);
  const result = await raceTimeout(page.evaluate(wrapper, argument ?? null), timeoutMs);
  return serializeLimited(result, maxBytes);
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolError("TIMEOUT", "The expression did not settle within the timeout."));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return await page.title();
  } catch {
    return "";
  }
}
