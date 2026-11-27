import { randomBytes, randomInt } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import type { Providers } from "../providers/index.js";
import type { ProviderSession } from "../providers/types.js";
import { ToolError } from "../util/errors.js";
import { createLock } from "../util/mutex.js";
import { CdpManager } from "./cdp.js";
import { connectRemote } from "./connect.js";
import { Diagnostics } from "./diagnostics.js";

export type SessionState = "creating" | "active" | "closing" | "closed";

export interface SessionSummary {
  browser_id: string;
  service: string;
  state: SessionState;
  url: string;
  created_at: string;
  last_used_at: string;
  idle_expires_at: string;
  hard_expires_at: string;
}

export interface ManagedSessionInit {
  id: string;
  owner: string;
  service: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  providerSession: ProviderSession;
  diagnostics: Diagnostics;
  config: AppConfig;
  onClosed: (id: string) => void;
}

/**
 * One remote browser session. All operations are serialized, idle and hard
 * lifetimes are enforced before every use, and closing is idempotent.
 */
export class ManagedSession {
  state: SessionState = "creating";
  readonly createdAt = Date.now();
  lastUsedAt = Date.now();
  readonly id: string;
  readonly owner: string;
  readonly service: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly diagnostics: Diagnostics;

  private currentPage: Page;
  private readonly providerSession: ProviderSession;
  private readonly config: AppConfig;
  private readonly onClosed: (id: string) => void;
  private readonly lock = createLock();
  private finalizing?: Promise<void>;

  constructor(init: ManagedSessionInit) {
    this.id = init.id;
    this.owner = init.owner;
    this.service = init.service;
    this.browser = init.browser;
    this.context = init.context;
    this.currentPage = init.page;
    this.diagnostics = init.diagnostics;
    this.providerSession = init.providerSession;
    this.config = init.config;
    this.onClosed = init.onClosed;
  }

  get page(): Page {
    return this.currentPage;
  }

  get hardExpiresAt(): number {
    return this.createdAt + this.config.session.maxLifetimeMs;
  }

  get idleExpiresAt(): number {
    return this.lastUsedAt + this.config.session.idleTtlMs;
  }

  summary(): SessionSummary {
    let url = "";
    try {
      url = this.page.url();
    } catch {
      url = "";
    }
    return {
      browser_id: this.id,
      service: this.service,
      state: this.state,
      url,
      created_at: new Date(this.createdAt).toISOString(),
      last_used_at: new Date(this.lastUsedAt).toISOString(),
      idle_expires_at: new Date(this.idleExpiresAt).toISOString(),
      hard_expires_at: new Date(this.hardExpiresAt).toISOString(),
    };
  }

  /** Runs `fn` under the session lock, after re-checking lifetime limits. */
  async run<T>(fn: (session: ManagedSession) => Promise<T>): Promise<T> {
    if (this.state !== "active") {
      throw new ToolError("SESSION_EXPIRED", "This browser session is no longer active.");
    }
    return this.lock(async () => {
      if (this.state !== "active") {
        throw new ToolError("SESSION_EXPIRED", "This browser session is no longer active.");
      }
      const reason = this.expiryReason(Date.now());
      if (reason) {
        await this.finalize(reason);
        throw new ToolError("SESSION_EXPIRED", `This browser session was closed (${reason}).`);
      }
      await this.ensurePageLimit();
      this.lastUsedAt = Date.now();
      try {
        return await fn(this);
      } catch (error) {
        throw this.mapError(error);
      }
    });
  }

  /** Marks the session active; called once the page is ready. */
  activate(): void {
    this.state = "active";
    this.lastUsedAt = Date.now();
  }

  /** Idempotent close used by clients, expiry and shutdown. */
  close(reason = "closed by client"): Promise<void> {
    return this.lock(() => this.finalize(reason));
  }

  /** Close triggered by the browser disconnecting under us. */
  disconnected(): Promise<void> {
    return this.lock(() => this.finalize("browser disconnected"));
  }

  expiryReason(now: number): string | null {
    if (now >= this.hardExpiresAt) return "maximum lifetime reached";
    if (now >= this.idleExpiresAt) return "idle timeout reached";
    return null;
  }

  private async ensurePageLimit(): Promise<void> {
    const maxPages = this.config.session.maxPages;
    const open = this.context.pages().filter(page => !page.isClosed());
    if (this.currentPage.isClosed()) {
      const replacement = open[0] ?? (await this.context.newPage());
      this.currentPage = replacement;
      this.diagnostics.rebindPage(replacement);
    }
    if (open.length <= maxPages) return;
    const keep = new Set<Page>([this.currentPage]);
    for (const page of open) {
      if (keep.size >= maxPages) break;
      keep.add(page);
    }
    for (const page of open) {
      if (keep.has(page)) continue;
      await page.close().catch(() => {});
    }
  }

  private finalize(reason: string): Promise<void> {    if (this.finalizing) return this.finalizing;
    this.state = "closing";
    this.finalizing = (async () => {
      try {
        this.diagnostics.dispose();
      } catch {
        /* diagnostics are best effort */
      }
      await this.browser.close().catch(() => {});
      await this.stopProvider();
    })().finally(() => {
      this.state = "closed";
      this.onClosed(this.id);
      void reason;
    });
    return this.finalizing;
  }

  private async stopProvider(): Promise<void> {
    try {
      await this.providerSession.stop();
    } catch {
      // Retry idempotent release once; the provider may already have cleaned up.
      await this.providerSession.stop().catch(() => {});
    }
  }

  private mapError(error: unknown): Error {
    if (error instanceof ToolError) return error;
    const message = this.config.redactor.error(error);
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError") {
      return new ToolError("TIMEOUT", `The browser operation timed out: ${message}`);
    }
    if (name === "TargetClosedError") {
      return new ToolError("SESSION_EXPIRED", "The remote browser or page closed.");
    }
    return new ToolError("PROVIDER_ERROR", `Browser operation failed: ${message}`);
  }
}

/**
 * Process-local registry of remote browser sessions. It is independent of the
 * stateless MCP HTTP transport: state survives across HTTP requests and is
 * keyed by `browser_id`, bound to the authenticated principal that opened it.
 */export class SessionRegistry {
  private readonly sessions = new Map<string, ManagedSession>();
  private pendingByOwner = new Map<string, number>();
  private pendingTotal = 0;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping?: Promise<number>;
  private closed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly providers: Providers,
  ) {}

  listServices(): Array<{ name: string }> {
    return [...this.providers.playwright.keys()].sort().map(name => ({ name }));
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(session => session.summary());
  }

  async open(service: string | undefined, owner: string): Promise<ManagedSession> {
    if (this.closed) throw new ToolError("SESSION_EXPIRED", "The server is shutting down.");
    if (service === undefined) {
      const available = [...this.providers.playwright.keys()];
      const preferred = available.filter(name => name === "hyperbrowser" || name === "browsercloud");
      const candidates = preferred.length > 0 ? preferred : available;
      if (candidates.length === 0) {
        throw new ToolError("SERVICE_UNAVAILABLE", "No Playwright services are configured or allowed.");
      }
      service = candidates[randomInt(candidates.length)]!;
    }
    const provider = this.providers.playwright.get(service);
    if (!provider) {
      throw new ToolError(
        "SERVICE_UNAVAILABLE",
        `The service ${JSON.stringify(service)} is not configured or not allowed.`,
      );
    }
    await this.sweep();
    this.assertQuota(owner);

    this.reserve(owner);
    let providerSession: ProviderSession | undefined;
    try {
      providerSession = await provider.open({
        maxLifetimeMs: this.config.session.maxLifetimeMs,
        timeoutMs: this.config.session.connectTimeoutMs,
      });
    } catch (error) {
      throw new ToolError(
        "PROVIDER_ERROR",
        `Could not create a ${service} browser session: ${this.config.redactor.error(error)}`,
      );
    } finally {
      this.release(owner);
    }

    let connection;
    try {
      connection = await connectRemote(providerSession, this.config.session.connectTimeoutMs);
    } catch (error) {
      await providerSession.stop().catch(() => {});
      throw new ToolError(
        "PROVIDER_ERROR",
        `Could not connect Playwright to ${service}: ${this.config.redactor.error(error)}`,
      );
    }

    try {
      return this.attach(service, owner, providerSession, connection);
    } catch (error) {
      await connection.browser.close().catch(() => {});
      await providerSession.stop().catch(() => {});
      throw new ToolError(
        "PROVIDER_ERROR",
        `Could not initialise the ${service} session: ${this.config.redactor.error(error)}`,
      );
    }
  }

  private attach(
    service: string,
    owner: string,
    providerSession: ProviderSession,
    connection: { browser: Browser; context: BrowserContext; page: Page },
  ): ManagedSession {
    const id = randomBytes(16).toString("hex");
    logEvent("session-created", {
      browser_id: id,
      service,
      provider_session_id: providerSession.providerSessionId,
    });
    const diagnostics = new Diagnostics(
      connection.page,
      this.config.diagnostics,
      new CdpManager(connection.context, connection.page, this.config.diagnostics),
    );
    const session = new ManagedSession({
      id,
      owner,
      service,
      browser: connection.browser,
      context: connection.context,
      page: connection.page,
      providerSession,
      diagnostics,
      config: this.config,
      onClosed: closedId => {
        this.sessions.delete(closedId);
        logEvent("session-closed", { browser_id: closedId });
      },
    });
    this.sessions.set(id, session);
    session.activate();
    connection.browser.on("disconnected", () => {
      void session.disconnected().catch(() => {});
    });
    return session;
  }
  /** Resolves a session for its owner; other principals see NOT_FOUND. */
  require(browserId: string, owner: string): ManagedSession {
    const session = this.sessions.get(browserId);
    if (!session || session.owner !== owner) {
      throw new ToolError("NOT_FOUND", "Unknown browser_id for this principal.");
    }
    if (session.state === "closing" || session.state === "closed") {
      throw new ToolError("SESSION_EXPIRED", "This browser session is closing.");
    }
    return session;
  }

  async withSession<T>(
    browserId: string,
    owner: string,
    fn: (session: ManagedSession) => Promise<T>,
  ): Promise<T> {
    return this.require(browserId, owner).run(fn);
  }

  async close(browserId: string, owner: string): Promise<{ browser_id: string; closed: boolean; already_closed: boolean }> {
    const session = this.sessions.get(browserId);
    // Idempotent: releasing an unknown or already-released id is not an error
    // and reveals nothing about sessions owned by other principals.
    if (!session || session.owner !== owner) {
      return { browser_id: browserId, closed: false, already_closed: true };
    }
    const alreadyClosed = session.state === "closed";
    if (!alreadyClosed) await session.close();
    return { browser_id: browserId, closed: true, already_closed: alreadyClosed };
  }

  /** Closes sessions past their idle or hard lifetime. Returns how many closed. */
  sweep(): Promise<number> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      const now = Date.now();
      const expired = [...this.sessions.values()].filter(
        session => session.state === "active" && session.expiryReason(now) !== null,
      );
      await Promise.allSettled(expired.map(session => session.close("expired")));
      return expired.length;
    })().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  startSweeper(intervalMs = 15_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, intervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    this.stopSweeper();
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map(session => session.close("server shutdown")));
  }

  counts(): { sessions: number; pending: number } {
    return { sessions: this.sessions.size, pending: this.pendingTotal };
  }

  private assertQuota(owner: string): void {
    const owned = [...this.sessions.values()].filter(
      session => session.owner === owner && session.state !== "closed",
    ).length;
    const pendingForOwner = this.pendingByOwner.get(owner) ?? 0;
    if (owned + pendingForOwner >= this.config.session.maxSessionsPerPrincipal) {
      throw new ToolError(
        "QUOTA_EXCEEDED",
        `At most ${this.config.session.maxSessionsPerPrincipal} concurrent browser sessions are allowed per principal.`,
      );
    }
    if (this.sessions.size + this.pendingTotal >= this.config.session.maxSessionsTotal) {
      throw new ToolError(
        "QUOTA_EXCEEDED",
        `At most ${this.config.session.maxSessionsTotal} concurrent browser sessions are allowed.`,
      );
    }
  }

  private reserve(owner: string): void {
    this.pendingByOwner.set(owner, (this.pendingByOwner.get(owner) ?? 0) + 1);
    this.pendingTotal += 1;
  }

  private release(owner: string): void {
    const remaining = (this.pendingByOwner.get(owner) ?? 1) - 1;
    if (remaining <= 0) this.pendingByOwner.delete(owner);
    else this.pendingByOwner.set(owner, remaining);
    this.pendingTotal = Math.max(0, this.pendingTotal - 1);
  }
}

/**
 * Structured lifecycle log for reconciliation after a crash. Contains only
 * opaque identifiers: no endpoints, secrets, URLs or page content.
 */
function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
