import type { BrowserContext, Page } from "playwright-core";
import type { DiagnosticLimits } from "../config.js";
import { ToolError } from "../util/errors.js";
import { serializeLimited } from "../util/limits.js";
import { BoundedBuffer } from "./buffers.js";

/** CDP commands permitted by default: inspection only, no page or browser mutation. */
const READ_ONLY_METHODS = new Set([
  "Accessibility.getFullAXTree",
  "Accessibility.getRootAXNode",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getDocument",
  "DOM.getNodeForLocation",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Performance.getMetrics",
]);

/**
 * Domain enablement that only switches on event emission. These add no
 * capability beyond the diagnostics buffers and change no page state.
 */
const EVENT_DOMAIN_METHODS = new Set(["Page.enable", "Network.enable", "Log.enable"]);

/** CDP events a caller may subscribe to for read-only diagnostics. */
const ALLOWED_EVENTS = new Set([
  "Inspector.targetCrashed",
  "Log.entryAdded",
  "Network.loadingFailed",
  "Network.loadingFinished",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Page.domContentEventFired",
  "Page.frameAttached",
  "Page.frameDetached",
  "Page.frameNavigated",
  "Page.frameStoppedLoading",
  "Page.javascriptDialogOpening",
  "Page.loadEventFired",
  "Page.windowOpen",
  "Runtime.exceptionThrown",
]);

export interface CdpEvent {
  at: number;
  method: string;
  params: string;
}

interface Subscription {
  cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>>;
  events: Set<string>;
  buffer: BoundedBuffer<CdpEvent>;
  createdAt: number;
  lastReadAt: number;
}

export class CdpManager {
  private commandSession?: Subscription["cdp"];
  private readonly subscriptions = new Map<string, Subscription>();
  private counter = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly limits: DiagnosticLimits,
  ) {}

  allowedMethods(): { readOnly: string[]; eventDomains: string[] } {
    return { readOnly: [...READ_ONLY_METHODS].sort(), eventDomains: [...EVENT_DOMAIN_METHODS].sort() };
  }

  allowedEvents(): string[] {
    return [...ALLOWED_EVENTS].sort();
  }

  /** Sends one allowlisted, read-only CDP command to the current page target. */
  async send(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    const allowed = READ_ONLY_METHODS.has(method) || EVENT_DOMAIN_METHODS.has(method);
    if (!allowed) {
      throw new ToolError(
        "UNSUPPORTED",
        `CDP method ${truncate(method, 80)} is not on the read-only allowlist.`,
      );
    }
    const session = await this.commandSessionFor();
    let result: unknown;
    try {
      result = await session.send(method as never, (params ?? {}) as never);
    } catch (error) {
      throw new ToolError(
        "PROVIDER_ERROR",
        `CDP ${truncate(method, 60)} failed: ${truncate(errorMessage(error), 200)}`,
      );
    }
    return serializeLimited(result, this.limits.maxCdpBytes);
  }

  async subscribe(events: readonly string[], maxEntries: number): Promise<{ subscriptionId: string; events: string[] }> {
    if (events.length === 0) throw new ToolError("INVALID_ARGUMENT", "events must not be empty.");
    for (const event of events) {
      if (!ALLOWED_EVENTS.has(event)) {
        throw new ToolError("UNSUPPORTED", `CDP event ${truncate(event, 80)} is not on the allowlist.`);
      }
    }
    if (this.subscriptions.size >= this.limits.maxSubscriptions) {
      throw new ToolError(
        "QUOTA_EXCEEDED",
        `At most ${this.limits.maxSubscriptions} CDP subscriptions are allowed per browser session.`,
      );
    }
    const cdp = await this.newSession();
    const subscription: Subscription = {
      cdp,
      events: new Set(events),
      buffer: new BoundedBuffer<CdpEvent>(maxEntries),
      createdAt: Date.now(),
      lastReadAt: Date.now(),
    };
    cdp.on("event", (payload: { method: string; params?: unknown }) => {
      if (!subscription.events.has(payload.method)) return;
      subscription.buffer.push({
        at: Date.now(),
        method: payload.method,
        params: truncate(safeJson(payload.params), 2_000),
      });
    });
    this.counter += 1;
    const subscriptionId = `cdp-${this.counter}`;
    this.subscriptions.set(subscriptionId, subscription);
    return { subscriptionId, events: [...events] };
  }

  read(subscriptionId: string): { events: CdpEvent[]; dropped: number; expired: boolean } {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new ToolError("NOT_FOUND", "Unknown subscription_id.");
    const now = Date.now();
    if (now - subscription.lastReadAt > this.limits.ttlMs) {
      this.disposeSubscription(subscriptionId);
      return { events: [], dropped: 0, expired: true };
    }
    subscription.lastReadAt = now;
    const { items, dropped } = subscription.buffer.drain(now, this.limits.ttlMs);
    return { events: items, dropped, expired: false };
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.disposeSubscription(subscriptionId);
  }

  dispose(): void {
    for (const id of [...this.subscriptions.keys()]) this.disposeSubscription(id);
    const commandSession = this.commandSession;
    this.commandSession = undefined;
    void commandSession?.detach().catch(() => {});
  }

  private disposeSubscription(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    this.subscriptions.delete(subscriptionId);
    subscription.buffer.clear();
    void subscription.cdp.detach().catch(() => {});
    return true;
  }

  private async commandSessionFor(): Promise<Subscription["cdp"]> {
    if (this.commandSession) return this.commandSession;
    this.commandSession = await this.newSession();
    return this.commandSession;
  }

  private async newSession(): Promise<Subscription["cdp"]> {
    try {
      return await this.context.newCDPSession(this.page);
    } catch (error) {
      throw new ToolError(
        "UNSUPPORTED",
        `CDP sessions are unavailable for this browser: ${truncate(errorMessage(error), 160)}`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown CDP error";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "\"[unserializable]\"";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
