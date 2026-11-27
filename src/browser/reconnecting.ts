import type { AppConfig } from "../config.js";
import type { Providers } from "../providers/index.js";
import type { PlaywrightProvider, ProviderSession } from "../providers/types.js";
import type { BrowserSessions } from "./session-contract.js";
import { ToolError, isToolError } from "../util/errors.js";
import { connectRemote, type Connection } from "./connect.js";
import { ManagedSession, SessionRegistry, type SessionSummary } from "./sessions.js";
import { SessionHandleCodec, type RemoteHandle } from "./session-handle.js";
import { Diagnostics } from "./diagnostics.js";
import { CdpManager } from "./cdp.js";
import { createLock } from "../util/mutex.js";

type Reconnectable = PlaywrightProvider & Required<Pick<PlaywrightProvider, "resume" | "activeCount">>;
const supportsReconnect = (provider: PlaywrightProvider): provider is Reconnectable =>
  Boolean(provider.resume && provider.activeCount);

/**
 * Stateless registry: the provider owns the browser, an encrypted browser_id
 * carries only the provider session ID and its owner. Each operation connects
 * to the provider's current endpoint and disconnects without stopping it.
 * The ordinary registry still handles one-call workflows for all providers.
 */
export class ReconnectingRegistry implements BrowserSessions {
  private readonly local: SessionRegistry;
  private readonly codec?: SessionHandleCodec;
  private readonly lock = createLock();

  constructor(
    private readonly config: AppConfig,
    private readonly providers: Providers,
    private readonly connect: typeof connectRemote = connectRemote,
    private readonly now: () => number = Date.now,
  ) {
    this.local = new SessionRegistry(config, providers);
    // Optional dedicated secret; the provider API key is a server-only fallback,
    // never derive handles from MCP_AUTH_TOKEN (which callers already know).
    const secret = config.providerEnv.BROWSER_SESSION_SECRET?.trim() || config.providerEnv.HYPERBROWSER_API_KEY?.trim();
    if (secret && !config.authTokens.includes(secret)) this.codec = new SessionHandleCodec(secret);
  }

  listServices() {
    return [...this.providers.playwright.values()].sort((a,b) => a.name.localeCompare(b.name)).map(provider => ({
      name: provider.name,
      reconnectable: Boolean(this.codec && supportsReconnect(provider)),
      workflows: true,
    }));
  }

  async open(service: string | undefined, owner: string, mode?: "workflow"): Promise<{ id: string; summary(): SessionSummary }> {
    if (mode === "workflow") return this.local.open(service, owner);
    return this.lock(async () => {
      const name = service ?? this.listServices().find(item => item.reconnectable)?.name;
      const provider = name ? this.providers.playwright.get(name) : undefined;
      if (!provider || !supportsReconnect(provider) || !this.codec) {
        throw new ToolError("SERVICE_UNAVAILABLE", "No reconnectable session for this service; use playwright_run or select a reconnectable provider.");
      }
      // No distributed counters: conservatively check the whole provider
      // account against both caps. Provider-side hard quota is still required
      // to prevent races between simultaneous cloud invocations.
      const count = await this.providerCall(() => provider.activeCount());
      if (count >= Math.min(this.config.session.maxSessionsTotal, this.config.session.maxSessionsPerPrincipal)) {
        throw new ToolError("QUOTA_EXCEEDED", "Provider account has reached the configured session admission limit.");
      }
      const lifetime = Math.min(45 * 60_000, Math.floor(this.config.session.maxLifetimeMs / 60_000) * 60_000);
      const createdAt = this.now();
      const remote = await this.providerCall(() => provider.open({
        maxLifetimeMs: lifetime, timeoutMs: this.config.session.connectTimeoutMs, reconnectable: true,
      }));
      let connection: Connection | undefined;
      try {
        connection = await this.providerCall(() => this.connect(remote, this.config.session.connectTimeoutMs, true));
        const handle = { service: provider.name, providerId: remote.providerSessionId, owner, createdAt, expiresAt: createdAt + lifetime };
        const id = this.codec!.encode(handle);
        const summary: SessionSummary = {
          browser_id: id, service: provider.name, state: "active", url: connection.page.url(),
          created_at: new Date(createdAt).toISOString(), last_used_at: new Date(this.now()).toISOString(),
          // There is no sliding idle clock without a shared state store.
          idle_expires_at: new Date(handle.expiresAt).toISOString(), hard_expires_at: new Date(handle.expiresAt).toISOString(),
        };
        await this.providerCall(() => connection!.browser.close());
        return { id, summary: () => summary };
      } catch (error) {
        await connection?.browser.close().catch(() => {});
        await remote.stop().catch(() => {});
        throw error;
      }
    });
  }

  async withSession<T>(id: string, owner: string, fn: (session: ManagedSession) => Promise<T>): Promise<T> {
    if (!id.startsWith("r1_")) return this.local.withSession(id, owner, fn);
    return this.lock(async () => {
      const { handle, provider } = this.resolve(id, owner);
      if (this.now() >= handle.expiresAt) throw new ToolError("SESSION_EXPIRED", "The browser session has expired.");
      const remote = await this.providerCall(() => provider.resume(handle.providerId));
      if (!remote) throw new ToolError("SESSION_EXPIRED", "The provider browser session has ended.");
      const connection = await this.providerCall(() => this.connect(remote, this.config.session.connectTimeoutMs, true));
      let session: ManagedSession | undefined;
      try {
        if (this.now() >= handle.expiresAt) throw new ToolError("SESSION_EXPIRED", "The browser session has expired.");
        const diagnostics = new Diagnostics(connection.page, this.config.diagnostics,
          new CdpManager(connection.context, connection.page, this.config.diagnostics));
        session = new ManagedSession({
          id, owner, service: handle.service, ...connection, diagnostics, config: this.config,
          providerSession: { ...remote, stop: async () => {} }, onClosed: () => {},
        });
        session.activate();
        return await session.run(fn);
      } finally {
        // Intentional disconnect only: provider stop belongs to explicit close.
        if (session) await session.close("request finished");
        else await connection.browser.close().catch(() => {});
      }
    });
  }

  async close(id: string, owner: string) {
    if (!id.startsWith("r1_")) return this.local.close(id, owner);
    return this.lock(async () => {
      let resolved;
      try { resolved = this.resolve(id, owner); }
      catch (error) {
        if (isToolError(error) && error.code === "NOT_FOUND") return { browser_id: id, closed: false, already_closed: true };
        throw error;
      }
      const remote = await this.providerCall(() => resolved.provider.resume(resolved.handle.providerId));
      if (!remote) return { browser_id: id, closed: false, already_closed: true };
      await this.providerCall(() => remote.stop());
      return { browser_id: id, closed: true, already_closed: false };
    });
  }

  closeAll(): Promise<void> { return this.local.closeAll(); }

  private resolve(id: string, owner: string): { handle: RemoteHandle; provider: Reconnectable } {
    if (!this.codec) throw new ToolError("NOT_FOUND", "Unknown browser_id for this principal.");
    const handle = this.codec.decode(id, owner);
    const provider = this.providers.playwright.get(handle.service);
    if (!provider || !supportsReconnect(provider)) throw new ToolError("SERVICE_UNAVAILABLE", "Session provider is not configured.");
    return { handle, provider };
  }

  private async providerCall<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) {
      if (isToolError(error)) throw error;
      // Endpoints sometimes include bearer credentials in their path, not just
      // the query string. Do not return raw provider or connection errors.
      throw new ToolError("PROVIDER_ERROR", "Provider session operation failed.");
    }
  }
}
