import type { ConsoleMessage, Page, Request, Response } from "playwright-core";
import type { DiagnosticLimits } from "../config.js";
import { stripUrlSecrets } from "../util/redact.js";
import { BoundedBuffer } from "./buffers.js";
import { CdpManager } from "./cdp.js";

export type BufferAction = "start" | "read" | "clear";

export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  location?: string;
}

export interface NetworkEntry {
  at: number;
  kind: "request" | "response" | "failure";
  method?: string;
  url: string;
  resourceType?: string;
  status?: number;
  durationMs?: number;
  failure?: string;
}

export interface ConsoleRead {
  started: boolean;
  expired: boolean;
  entries: ConsoleEntry[];
  dropped: number;
  capacity: number;
}

export interface NetworkRead {
  started: boolean;
  expired: boolean;
  entries: NetworkEntry[];
  dropped: number;
  capacity: number;
}

const MAX_TEXT = 500;
const MAX_URL = 300;

/**
 * Bounded, read-only page diagnostics.
 *
 * Console messages and page errors keep their text; network entries keep
 * metadata only and never headers or bodies. URLs are stripped of query strings
 * so tokens carried in query parameters are not echoed back. Buffers are dropped
 * after `ttlMs` without a read and count what they lost.
 */
export class Diagnostics {
  private cdpManager: CdpManager;
  private page: Page;
  private console?: { buffer: BoundedBuffer<ConsoleEntry>; lastReadAt: number; detach: () => void };
  private network?: { buffer: BoundedBuffer<NetworkEntry>; lastReadAt: number; detach: () => void };

  constructor(
    page: Page,
    private readonly limits: DiagnosticLimits,
    cdp: CdpManager,
  ) {
    this.page = page;
    this.cdpManager = cdp;
  }

  get cdp(): CdpManager {
    return this.cdpManager;
  }

  /**
   * Moves diagnostics to a replacement tab after the original one closed.
   * Buffers that were collecting are restarted on the new page.
   */
  rebindPage(page: Page): void {
    const consoleWasStarted = Boolean(this.console);
    const networkWasStarted = Boolean(this.network);
    this.stopConsole();
    this.stopNetwork();
    this.cdpManager.dispose();
    this.page = page;
    this.cdpManager = new CdpManager(page.context(), page, this.limits);
    if (consoleWasStarted) this.consoleAction("start");
    if (networkWasStarted) this.networkAction("start");
  }

  consoleAction(action: BufferAction): ConsoleRead {
    if (action === "start") {
      if (!this.console || this.stale(this.console.lastReadAt)) {
        this.stopConsole();
        this.console = { buffer: new BoundedBuffer<ConsoleEntry>(this.limits.maxEntries), lastReadAt: Date.now(), detach: this.attachConsole() };
      }
      return { started: true, expired: false, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    if (action === "clear") {
      this.console?.buffer.clear();
      return { started: Boolean(this.console), expired: false, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    const active = this.console;
    if (!active) {
      return { started: false, expired: false, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    if (this.stale(active.lastReadAt)) {
      this.stopConsole();
      return { started: false, expired: true, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    active.lastReadAt = Date.now();
    const { items, dropped } = active.buffer.drain(Date.now(), this.limits.ttlMs);
    return { started: true, expired: false, entries: items, dropped, capacity: this.limits.maxEntries };
  }

  networkAction(action: BufferAction): NetworkRead {
    if (action === "start") {
      if (!this.network || this.stale(this.network.lastReadAt)) {
        this.stopNetwork();
        this.network = { buffer: new BoundedBuffer<NetworkEntry>(this.limits.maxEntries), lastReadAt: Date.now(), detach: this.attachNetwork() };
      }
      return { started: true, expired: false, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    if (action === "clear") {
      this.network?.buffer.clear();
      return { started: Boolean(this.network), expired: false, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    const active = this.network;
    if (!active) {
      return { started: false, expired: false, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    if (this.stale(active.lastReadAt)) {
      this.stopNetwork();
      return { started: false, expired: true, entries: [], dropped: 0, capacity: this.limits.maxEntries };
    }
    active.lastReadAt = Date.now();
    const { items, dropped } = active.buffer.drain(Date.now(), this.limits.ttlMs);
    return { started: true, expired: false, entries: items, dropped, capacity: this.limits.maxEntries };
  }

  dispose(): void {
    this.stopConsole();
    this.stopNetwork();
    this.cdp.dispose();
  }

  private stale(lastReadAt: number): boolean {
    return Date.now() - lastReadAt > this.limits.ttlMs;
  }

  private stopConsole(): void {
    if (!this.console) return;
    this.console.detach();
    this.console.buffer.clear();
    this.console = undefined;
  }

  private stopNetwork(): void {
    if (!this.network) return;
    this.network.detach();
    this.network.buffer.clear();
    this.network = undefined;
  }

  private attachConsole(): () => void {
    const onConsole = (message: ConsoleMessage) => {
      const location = message.location();
      const entry: ConsoleEntry = {
        at: Date.now(),
        level: message.type(),
        text: clip(message.text(), MAX_TEXT),
        ...(location.url ? { location: clip(stripUrlSecrets(location.url), MAX_URL) } : {}),
      };
      this.console?.buffer.push(entry);
    };
    const onPageError = (error: Error) => {
      this.console?.buffer.push({
        at: Date.now(),
        level: "pageerror",
        text: clip(`${error.name}: ${error.message}`, MAX_TEXT),
      });
    };
    this.page.on("console", onConsole);
    this.page.on("pageerror", onPageError);
    return () => {
      this.page.off("console", onConsole);
      this.page.off("pageerror", onPageError);
    };
  }

  private attachNetwork(): () => void {
    const startedAt = new Map<Request, number>();
    const onRequest = (request: Request) => {
      startedAt.set(request, Date.now());
      this.network?.buffer.push({
        at: Date.now(),
        kind: "request",
        method: request.method(),
        url: clip(stripUrlSecrets(request.url()), MAX_URL),
        resourceType: request.resourceType(),
      });
    };
    const onResponse = (response: Response) => {
      const request = response.request();
      const start = startedAt.get(request);
      this.network?.buffer.push({
        at: Date.now(),
        kind: "response",
        method: request.method(),
        url: clip(stripUrlSecrets(response.url()), MAX_URL),
        resourceType: request.resourceType(),
        status: response.status(),
        ...(start !== undefined ? { durationMs: Date.now() - start } : {}),
      });
    };
    const onFailed = (request: Request) => {
      const failure = request.failure();
      this.network?.buffer.push({
        at: Date.now(),
        kind: "failure",
        method: request.method(),
        url: clip(stripUrlSecrets(request.url()), MAX_URL),
        resourceType: request.resourceType(),
        failure: clip(failure?.errorText ?? "request failed", 200),
      });
    };
    this.page.on("request", onRequest);
    this.page.on("response", onResponse);
    this.page.on("requestfailed", onFailed);
    return () => {
      this.page.off("request", onRequest);
      this.page.off("response", onResponse);
      this.page.off("requestfailed", onFailed);
    };
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
