import { Hyperbrowser } from "@hyperbrowser/sdk";
import type { OpenOptions, PlaywrightProvider, ProviderSession } from "./types.js";

/**
 * Hyperbrowser: session create returns `wsEndpoint`; stop the session through
 * the SDK. https://www.hyperbrowser.ai/browser-sessions
 */
export class HyperbrowserProvider implements PlaywrightProvider {
  readonly name = "hyperbrowser";
  readonly connectionKind = "cdp" as const;
  private readonly client: Hyperbrowser;

  constructor(apiKey: string) {
    this.client = new Hyperbrowser({ apiKey });
  }

  async open(options: OpenOptions): Promise<ProviderSession> {
    const client = this.client;
    const timeoutMinutes = Math.max(1, Math.min(45, Math.ceil(options.maxLifetimeMs / 60_000)));
    const session = await client.sessions.create({ timeoutMinutes });
    if (typeof session.wsEndpoint !== "string" || session.wsEndpoint.length === 0) {
      // Stop nothing: the SDK never gave us a usable endpoint for this session.
      throw new Error("hyperbrowser did not return a wsEndpoint");
    }
    return {
      providerSessionId: session.id,
      endpoint: session.wsEndpoint,
      connectionKind: this.connectionKind,
      async stop() {
        await client.sessions.stop(session.id);
      },
    };
  }
}
