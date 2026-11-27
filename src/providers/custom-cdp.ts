import type { OpenOptions, PlaywrightProvider, ProviderSession } from "./types.js";

/** A configured CDP endpoint managed outside this server. */
export class CustomCdpProvider implements PlaywrightProvider {
  readonly connectionKind = "cdp" as const;

  constructor(readonly name: string, private readonly endpoint: string) {
    try {
      const url = new URL(endpoint);
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid CDP endpoint for service ${name}.`);
    }
  }

  async open(_options: OpenOptions): Promise<ProviderSession> {
    return {
      providerSessionId: `custom-cdp:${this.name}`,
      endpoint: this.endpoint,
      connectionKind: this.connectionKind,
      async stop() {
        // The endpoint owner controls the browser lifecycle.
      },
    };
  }
}
