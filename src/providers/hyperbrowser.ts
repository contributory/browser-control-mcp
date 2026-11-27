import { Hyperbrowser } from "@hyperbrowser/sdk";
import type { OpenOptions, PlaywrightProvider, ProviderSession } from "./types.js";

/**
 * Hyperbrowser owns the browser lifetime. keepAlive=true preserves it when
 * Playwright disconnects, and sessions.get resolves the current CDP endpoint.
 * https://docs.hyperbrowser.ai/browser-sessions/lifecycle
 */
export class HyperbrowserProvider implements PlaywrightProvider {
  readonly name = "hyperbrowser";
  readonly connectionKind = "cdp" as const;
  private readonly client: Hyperbrowser;

  constructor(apiKey: string) {
    this.client = new Hyperbrowser({ apiKey });
  }

  async open(options: OpenOptions): Promise<ProviderSession> {
    const timeoutMinutes = Math.max(1, Math.min(45, Math.floor(options.maxLifetimeMs / 60_000)));
    const session = await this.client.sessions.create({ timeoutMinutes });
    try {
      return this.adapt(session, Boolean(options.reconnectable));
    } catch (error) {
      await this.client.sessions.stop(session.id).catch(() => {});
      throw error;
    }
  }

  async resume(id: string): Promise<ProviderSession | null> {
    let session;
    try {
      session = await this.client.sessions.get(id);
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404) return null;
      throw error;
    }
    if (session.status !== "active") return null;
    return this.adapt(session, true);
  }

  async activeCount(): Promise<number> {
    const result = await this.client.sessions.getActiveSessionsCount();
    if (!Number.isSafeInteger(result.activeSessionsCount) || result.activeSessionsCount < 0) {
      throw new Error("Invalid active session count");
    }
    return result.activeSessionsCount;
  }

  private adapt(session: { id: string; wsEndpoint: string }, reconnectable: boolean): ProviderSession {
    if (!session.wsEndpoint) throw new Error("Hyperbrowser did not return a wsEndpoint");
    const endpoint = new URL(session.wsEndpoint);
    if (reconnectable) endpoint.searchParams.set("keepAlive", "true");
    return {
      providerSessionId: session.id,
      endpoint: endpoint.toString(),
      connectionKind: this.connectionKind,
      stop: async () => { await this.client.sessions.stop(session.id); },
    };
  }
}
